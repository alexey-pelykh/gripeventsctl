// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * The output module (issue #9 § Output): the human renderings, the `--json` form, the redaction backstop and the
 * terminal escaping, one path for the CLI and the MCP text block.
 *
 * - `--json`: `JSON.stringify(output, null, 2)` on stdout, unchanged (an array stays an array, epoch seconds stay
 *   numbers), followed by a newline.
 * - Human output: an array of flat records renders as a table, one column per key in schema order, box-drawing
 *   characters (`cli-table3`) only on a TTY and plain `|`-separated rows otherwise; an object renders as key-value
 *   lines `<key>: <value>` in schema order; a nested array or object inside a record renders as compact JSON in its
 *   cell; an empty array renders `render.emptyText` (default `no results`) as a statement, never as an error; a field
 *   named in `render.epochFields` renders as local ISO 8601 with the offset (`2026-10-12T19:09:00+02:00`); a key
 *   named `thing_id` or `id` is always a visible column, as every key of a record is. Colour is used only for
 *   emphasis (the table header in bold), never as the only carrier of a state, and is off when `NO_COLOR` is set or
 *   stdout is not a TTY.
 * - The redaction backstop: `writeOutput()` passes the human text and the `--json` text through `redactString`
 *   before writing, and `redactOutput()` does the same for every string value of the MCP `structuredContent`, the
 *   last line of defence behind the projections. `redactString` runs last: render, then redact, then write, so a
 *   table cell cannot re-join a split secret.
 * - Terminal escaping (`escapeForTerminal`): in every human rendering and in the MCP text block, the C0 and C1
 *   control characters other than `\n` and `\t` (U+0000 to U+0008, U+000B to U+001F, U+007F, U+0080 to U+009F)
 *   render as `\x..` (two lowercase hex digits), and the bidirectional overrides, embeddings and isolates (U+202A to
 *   U+202E, U+2066 to U+2069) and the zero-width characters (U+200B to U+200D, U+FEFF) render as `\u{....}`
 *   (lowercase hex, braces). `\n`, `\t` and every other character, right-to-left letters included, pass through
 *   unchanged. `--json` output and `structuredContent` stay raw: they are for machines, and an assistant host renders
 *   them itself. Each value is escaped before the table is laid out, so the columns are measured on what is shown.
 */

import { type Operation, ApiError, redactString } from "@gripeventsctl/core";
import Table from "cli-table3";
import type { z } from "zod";

import type { OutputStream } from "./terminal.js";

/** The rendering hints of an operation, `Operation["render"]`. */
export interface RenderHints {
  /** The output keys that hold epoch seconds. */
  epochFields?: readonly string[] | undefined;
  /** The sentence printed for an empty array result. */
  emptyText?: string | undefined;
}

export interface RenderOptions {
  /** The operation's output schema: the keys of its object, or of its array's element, fix the column and key order. */
  schema?: z.ZodType | undefined;
  render?: RenderHints | undefined;
  /** Box-drawing table on a TTY; plain `|`-separated rows otherwise (a pipe, the MCP text block). */
  tty?: boolean | undefined;
  /** Colour for emphasis; off under `NO_COLOR` and off a TTY. */
  colour?: boolean | undefined;
}

export interface WriteOutputOptions extends RenderOptions {
  /** The `--json` form: the output serialised, unchanged. */
  json: boolean;
  /** Where the text goes, with its one trailing newline; the CLI passes its terminal-bound stdout. */
  stdout: OutputStream;
}

export const DEFAULT_EMPTY_TEXT = "no results";

/** The separator of the plain table form. */
const PLAIN_SEPARATOR = " | ";

/** A C0 or C1 control character other than `\n` and `\t`. */
function isControlCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x08 ||
    (codePoint >= 0x0b && codePoint <= 0x1f) ||
    codePoint === 0x7f ||
    (codePoint >= 0x80 && codePoint <= 0x9f)
  );
}

/** A bidirectional override, embedding or isolate, or a zero-width character. */
function isInvisibleCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    (codePoint >= 0x200b && codePoint <= 0x200d) ||
    codePoint === 0xfeff
  );
}

/**
 * `text` with every control, bidirectional and zero-width code point of the table above in its visible form, by
 * code point, so an astral character is never split. Pure: the same input gives the same output.
 */
export function escapeForTerminal(text: string): string {
  let escaped = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isControlCodePoint(codePoint)) escaped += `\\x${codePoint.toString(16).padStart(2, "0")}`;
    else if (isInvisibleCodePoint(codePoint)) escaped += `\\u{${codePoint.toString(16)}}`;
    else escaped += character;
  }
  return escaped;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** `epochSeconds` as local ISO 8601 with the offset, `2026-10-12T19:09:00+02:00`, in the process's time zone. */
export function localIso(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${day}T${time}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** The parts of a zod 4 definition the renderer reads: the kind, an object's shape and an array's element. */
interface SchemaDefinition {
  type: string;
  shape?: Record<string, unknown>;
  element?: z.ZodType;
}

function definitionOf(schema: z.ZodType | undefined): SchemaDefinition | undefined {
  return schema === undefined ? undefined : schema._zod.def;
}

/** The keys of an object schema, in declaration order; `undefined` for any other schema. */
function shapeKeys(schema: z.ZodType | undefined): string[] | undefined {
  const definition = definitionOf(schema);
  return definition?.type === "object" && definition.shape !== undefined ? Object.keys(definition.shape) : undefined;
}

/** The keys of an array schema's object element; `undefined` for any other schema. */
function elementKeys(schema: z.ZodType | undefined): string[] | undefined {
  const definition = definitionOf(schema);
  return definition?.type === "array" ? shapeKeys(definition.element) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One value as the human form shows it: an epoch field as local ISO 8601, a nested value as compact JSON. */
function formatValue(value: unknown, key: string, epochFields: readonly string[]): string {
  if (epochFields.includes(key) && typeof value === "number" && Number.isFinite(value)) return localIso(value);
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value);
}

/** The schema's keys first, then every other key a record holds, in order of first appearance. */
function columnsOf(records: readonly Record<string, unknown>[], schema: z.ZodType | undefined): string[] {
  const columns = elementKeys(schema) ?? [];
  const seen = new Set(columns);
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

/** The schema's keys the object holds, in schema order, then every other key the object holds. */
function keysOf(object: Record<string, unknown>, schema: z.ZodType | undefined): string[] {
  const keys = (shapeKeys(schema) ?? []).filter((key) => object[key] !== undefined);
  const seen = new Set(keys);
  for (const key of Object.keys(object)) {
    if (seen.has(key) || object[key] === undefined) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function renderTable(
  records: readonly Record<string, unknown>[],
  columns: readonly string[],
  epochFields: readonly string[],
  tty: boolean,
  colour: boolean,
): string {
  const rows = records.map((record) =>
    columns.map((column) => escapeForTerminal(formatValue(record[column], column, epochFields))),
  );
  if (!tty) return [columns.join(PLAIN_SEPARATOR), ...rows.map((row) => row.join(PLAIN_SEPARATOR))].join("\n");
  // Off a TTY `cli-table3` would still emit its default colours; here the styles are empty unless colour is on.
  const table = new Table({ head: [...columns], style: { head: colour ? ["bold"] : [], border: [] } });
  for (const row of rows) table.push(row);
  return table.toString();
}

/**
 * The human form of `output`, escaped, without a trailing newline: a table for an array of flat records, key-value
 * lines for an object, the empty-text sentence for an empty array, one line per entry for an array of scalars, and
 * the value itself for a scalar.
 */
export function renderHuman(output: unknown, options: RenderOptions = {}): string {
  const epochFields = options.render?.epochFields ?? [];
  const tty = options.tty === true;
  const colour = tty && options.colour === true;
  if (Array.isArray(output)) {
    if (output.length === 0) return options.render?.emptyText ?? DEFAULT_EMPTY_TEXT;
    if (output.every(isRecord)) return renderTable(output, columnsOf(output, options.schema), epochFields, tty, colour);
    return output.map((entry: unknown) => escapeForTerminal(formatValue(entry, "", epochFields))).join("\n");
  }
  if (isRecord(output)) {
    return keysOf(output, options.schema)
      .map((key) => `${key}: ${escapeForTerminal(formatValue(output[key], key, epochFields))}`)
      .join("\n");
  }
  return escapeForTerminal(formatValue(output, "", epochFields));
}

/** `value` with every string in it, at any depth, passed through `redactString`; every other value as it is. */
export function redactOutput<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((entry: unknown) => redactOutput(entry)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactOutput(entry)])) as T;
  }
  return value;
}

/**
 * `value` validated by the operation's output schema: the projection that drops every key the schema does not name.
 * A failure is the `api` kind naming the first documented field that is missing or not of the documented type, in
 * the words the transport uses for an answer.
 */
export function validateOutput(operation: Pick<Operation, "group" | "verb" | "output">, value: unknown): unknown {
  const result = operation.output.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue === undefined ? "" : issue.path.map(String).join(".");
  const subject = field === "" ? "the answer" : `the documented field ${field}`;
  const detail = `${subject} is missing or not of the documented type${issue === undefined ? "" : ` (${issue.message})`}`;
  throw new ApiError(`${operation.group} ${operation.verb}: ${detail}`, detail);
}

/**
 * Write `output` in the `--json` form or the human form, through `redactString` last, with one trailing newline.
 * The MCP builder renders its text block with `renderHuman` and redacts its structured content with `redactOutput`
 * instead of writing.
 */
export function writeOutput(output: unknown, options: WriteOutputOptions): void {
  const text = options.json ? JSON.stringify(output, null, 2) : renderHuman(output, options);
  options.stdout.write(`${redactString(text)}\n`);
}
