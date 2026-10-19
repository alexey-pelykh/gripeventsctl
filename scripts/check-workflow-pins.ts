#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Oleksii PELYKH

/**
 * Workflow pin check.
 *
 * Parses `.github/workflows/*.yml` (and `*.yaml`), `.github/actions/*\/action.yml` (and
 * `action.yaml`), the root `package.json` and every `packages/*\/package.json`, and fails on any
 * finding of the ten rules below. The YAML and JSON are parsed, not matched as text, for `uses:`,
 * `permissions`, `needs`, `with` and `strategy`; the `run:` rules are regular expressions over the
 * step's script, with backslash line continuations joined first.
 *
 *   1. A `uses:` (a step's, a composite action step's or a job's reusable-workflow call) that is
 *      not `./<local path>` and does not match `<owner>/<repo>(/<path>)?@<40 lowercase hex>`.
 *   2. In a job holding `id-token: write`: a `run:` step that installs or runs a package without an
 *      exact version: `npm install -g`, `npm i -g`, `npx` or `pnpm dlx` followed by a package spec
 *      with no version, or whose version contains `^`, `~`, `>`, `<`, `*`, `latest` or an `x`
 *      component (`1.x`). Quotes are stripped first, so `"npm@>=11.5.1"` and `npm@>=11.5.1` read
 *      alike. `npx` and `pnpm dlx` take one spec, `npm install -g` every spec up to the end of the
 *      command; tokens starting with `-` are flags and skipped.
 *   3. In a job holding `id-token: write`: a `run:` step that mentions `cdxgen`.
 *   4. A `run:` step that downloads `mcp-publisher` (`mcp-publisher` and `releases/download` in the
 *      same step) without, in that step, writing the download to a file (`curl -o`/`--output`,
 *      `wget -O`/`--output-document`) and checking it with `sha256sum -c` or `shasum -a 256 -c`
 *      before any command that executes `mcp-publisher`; or any `run:` step that downloads from
 *      `releases/latest/download` (unpinned).
 *   5. The `validate` job of `release.yml`: every `actions/checkout` step carries `fetch-depth: 0`,
 *      and the steps run `pnpm check-secret-leakage --history`, `pnpm check-api-docs-dated --strict`
 *      and `pnpm check-test-traceability --strict` (as a step's whole `run`, or as a line of one).
 *   6. The job whose steps run `mcp-publisher publish`: its `needs` includes `publish-npm` and its own
 *      `permissions` are exactly `{ contents: read, id-token: write }`; and `release.yml` holds such a
 *      job (reported against the file when none does).
 *   7. Every `pnpm install` in a composite action carries `--frozen-lockfile` and `--ignore-scripts`,
 *      and the setup action `.github/actions/setup/action.yml` runs one.
 *   8. `ci.yml`'s `ci` job matrix equals `os: [ubuntu-latest, macos-latest, windows-latest]` and
 *      `node-version: ["22", "24"]`, nothing more.
 *   9. `engines.node` is exactly `>=22.19.0` in the root `package.json` and every
 *      `packages/*\/package.json`.
 *  10. Every workflow's top-level `permissions` is exactly `contents: read` (a missing block leaves
 *      the repository's default token rights in force, so it counts as a finding).
 *
 * A job holds `id-token: write` when its own `permissions` grant it, or `write-all`; a job declaring
 * no `permissions` inherits the workflow's top-level block, so rules 2 and 3 read that one.
 *
 * Exit codes:
 *   0: clean
 *   1: findings, one line per finding on stderr:
 *      `<file>: job <job>: rule <n> (<description>): <message>`, the `job <job>: ` part omitted when
 *      the finding is against the file
 *   2: a usage, read or parse error (a YAML or JSON file that does not parse, a workflow that is not
 *      a mapping, a missing `.github/workflows/` or root `package.json`)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

export const WORKFLOWS_DIR = ".github/workflows";
export const ACTIONS_DIR = ".github/actions";
export const SETUP_ACTION = ".github/actions/setup/action.yml";
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";
export const CI_WORKFLOW = ".github/workflows/ci.yml";

/** The one Node.js floor every manifest declares. */
export const ENGINES_NODE = ">=22.19.0";

/** The CI matrix: three operating systems, the declared floor (22) and the current LTS (24). */
export const CI_MATRIX = {
  os: ["ubuntu-latest", "macos-latest", "windows-latest"],
  "node-version": ["22", "24"],
};

/** The registry job's whole token: the checkout and the OIDC login, nothing else. */
export const REGISTRY_JOB_PERMISSIONS = { contents: "read", "id-token": "write" };

/** The top-level token of every workflow; every wider right is granted per job. */
export const TOP_LEVEL_PERMISSIONS = { contents: "read" };

/** The strict checks the release `validate` job runs. */
export const VALIDATE_RUNS = [
  "pnpm check-secret-leakage --history",
  "pnpm check-api-docs-dated --strict",
  "pnpm check-test-traceability --strict",
] as const;

/** `<owner>/<repo>(/<path>)?@<40 lowercase hex>`: an action pinned by commit SHA. */
export const PINNED_USES = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[^@]+)?@[0-9a-f]{40}$/u;

export interface WorkflowFile {
  /** Repository-relative, forward slashes. */
  path: string;
  doc: unknown;
}

export interface ActionFile {
  path: string;
  doc: unknown;
}

export interface PackageFile {
  path: string;
  doc: unknown;
}

export interface Input {
  workflows: WorkflowFile[];
  actions: ActionFile[];
  packages: PackageFile[];
}

export interface Finding {
  file: string;
  job?: string;
  rule: number;
  message: string;
}

export interface Rule {
  id: number;
  description: string;
  check(input: Input): Finding[];
}

/** A read or parse failure: exit 2, naming the file. */
export class InputError extends Error {}

type Mapping = Record<string, unknown>;

function asMapping(value: unknown): Mapping | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Mapping) : undefined;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Structural equality over the JSON-like values YAML and JSON parse to. */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  const a = asMapping(left);
  const b = asMapping(right);
  if (a === undefined || b === undefined) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

/** A value as it reads in a finding line. */
function show(value: unknown): string {
  return value === undefined ? "(none)" : JSON.stringify(value);
}

interface Job {
  name: string;
  body: Mapping;
}

function jobsOf(doc: unknown): Job[] {
  const jobs = asMapping(asMapping(doc)?.["jobs"]);
  if (jobs === undefined) return [];
  return Object.entries(jobs).flatMap(([name, body]) => {
    const mapping = asMapping(body);
    return mapping === undefined ? [] : [{ name, body: mapping }];
  });
}

/** The steps of a job, or of a composite action's `runs`. */
function stepsOf(container: Mapping | undefined): Mapping[] {
  return asList(container?.["steps"]).flatMap((step) => {
    const mapping = asMapping(step);
    return mapping === undefined ? [] : [mapping];
  });
}

function actionSteps(action: ActionFile): Mapping[] {
  return stepsOf(asMapping(asMapping(action.doc)?.["runs"]));
}

function runOf(step: Mapping): string | undefined {
  const run = step["run"];
  if (typeof run === "string") return run;
  if (typeof run === "number" || typeof run === "boolean") return String(run);
  return undefined;
}

function stepLabel(step: Mapping, index: number): string {
  const name = step["name"];
  return typeof name === "string" && name.length > 0 ? `step "${name}"` : `step ${String(index + 1)}`;
}

/** Joins backslash line continuations, so a command split over lines reads as one. */
export function joinContinuations(script: string): string {
  return script.replace(/\\\r?\n/gu, " ");
}

/** The workflow at `.github/workflows/<base>.yml`, or `.yaml`. */
function findWorkflow(input: Input, base: string): WorkflowFile | undefined {
  return input.workflows.find(
    (workflow) => workflow.path === `${WORKFLOWS_DIR}/${base}.yml` || workflow.path === `${WORKFLOWS_DIR}/${base}.yaml`,
  );
}

function isSetupAction(path: string): boolean {
  return path === SETUP_ACTION || path === `${ACTIONS_DIR}/setup/action.yaml`;
}

/** The permissions a job runs with: its own block, else the workflow's top-level one. */
function effectivePermissions(job: Job, workflow: WorkflowFile): { value: unknown; inherited: boolean } {
  if (Object.hasOwn(job.body, "permissions")) return { value: job.body["permissions"], inherited: false };
  return { value: asMapping(workflow.doc)?.["permissions"], inherited: true };
}

function holdsIdToken(permissions: unknown): boolean {
  if (permissions === "write-all") return true;
  return asMapping(permissions)?.["id-token"] === "write";
}

function reporter(rule: number) {
  return (file: string, message: string, job?: string): Finding =>
    job === undefined ? { file, rule, message } : { file, job, rule, message };
}

/** Every job holding `id-token: write`, with its workflow and whether the right is inherited. */
function idTokenJobs(input: Input): { workflow: WorkflowFile; job: Job; inherited: boolean }[] {
  return input.workflows.flatMap((workflow) =>
    jobsOf(workflow.doc).flatMap((job) => {
      const { value, inherited } = effectivePermissions(job, workflow);
      return holdsIdToken(value) ? [{ workflow, job, inherited }] : [];
    }),
  );
}

function tokenNote(inherited: boolean): string {
  return inherited ? " (id-token: write inherited from the top-level permissions)" : "";
}

/** Why a `uses:` value fails rule 1, or `undefined` when it is local or SHA-pinned. */
export function usesProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return `uses is ${show(value)}, not a string`;
  if (value.startsWith("./")) return undefined;
  if (PINNED_USES.test(value)) return undefined;
  return `uses ${value}: not ./<local path> and not pinned to a 40-character lowercase commit SHA`;
}

/** Why a package spec fails rule 2, or `undefined` when it names an exact version. */
export function packageSpecProblem(spec: string): string | undefined {
  const slash = spec.indexOf("/");
  const from = spec.startsWith("@") ? (slash === -1 ? 1 : slash + 1) : 0;
  const at = spec.indexOf("@", from);
  if (at === -1 || at === spec.length - 1) return "missing a version";
  const version = spec.slice(at + 1);
  if (/[\^~<>*]/u.test(version) || /(?:^|\.)[xX](?=$|\.)/u.test(version) || version.includes("latest")) {
    return `version ${version} is not exact`;
  }
  return undefined;
}

/** `npm install -g`, `npm i -g`, `npx` or `pnpm dlx` as a command, not inside a longer word. */
const INSTALL_COMMAND = /(?<![\w.-])(npm\s+(?:install|i)\s+-g|npx|pnpm\s+dlx)(?=\s|$)/gu;

/** The end of a shell command: a line break, a separator, a pipe or a closing subshell. */
const COMMAND_END = /[\n;&|)]/u;

export interface UnpinnedInstall {
  command: string;
  spec: string;
  problem: string;
}

/** The package specs a script installs or runs without an exact version (rule 2). */
export function unpinnedInstalls(script: string): UnpinnedInstall[] {
  const text = joinContinuations(script.replace(/["']/gu, ""));
  const found: UnpinnedInstall[] = [];
  for (const match of text.matchAll(INSTALL_COMMAND)) {
    const command = (match[1] ?? "").replace(/\s+/gu, " ");
    const tail = text.slice(match.index + match[0].length).split(COMMAND_END)[0] ?? "";
    const tokens = tail
      .trim()
      .split(/\s+/u)
      .filter((token) => token.length > 0 && !token.startsWith("-"));
    const specs = command.startsWith("npm ") ? tokens : tokens.slice(0, 1);
    if (specs.length === 0) {
      found.push({ command, spec: "", problem: "names no package spec" });
      continue;
    }
    for (const spec of specs) {
      const problem = packageSpecProblem(spec);
      if (problem !== undefined) found.push({ command, spec, problem });
    }
  }
  return found;
}

/** `curl` writing to a file: `-o <file>` (also in a flag cluster, `-fsSLo <file>`) or `--output`. */
const CURL_TO_FILE = /\bcurl\b[^\n]*?\s(?:-[A-Za-z]*o|--output(?=[=\s]))[=\s]*(?!-(?:\s|$))[^\s|;&]/u;

/** `wget` writing to a file: `-O <file>` (not `-O -`, standard output) or `--output-document`. */
const WGET_TO_FILE = /\bwget\b[^\n]*?\s(?:-[A-Za-z]*O|--output-document(?=[=\s]))[=\s]*(?!-(?:\s|$))[^\s|;&]/u;

/** `sha256sum ... -c` or `shasum -a 256 ... -c` (also `--check`), on one line. */
const CHECKSUM_CHECK =
  /\bsha256sum\b[^\n]*?\s(?:-c|--check)(?=\s|$)|\bshasum\b(?=[^\n]*\s(?:-a\s*256|--algorithm[=\s]256)(?=\s|$))[^\n]*?\s(?:-c|--check)(?=\s|$)/mu;

/** A command that executes `mcp-publisher` (`./mcp-publisher`, a path to it, or the bare name). */
const PUBLISHER_EXEC = /(?:^|[;&|(]|\$\()\s*(?:sudo\s+)?(?:[\w.~${}-]*\/)*mcp-publisher(?=\s|$|[;&|)])/mu;

/** Why a step's script fails rule 4; empty when it downloads nothing the rule grades. */
export function downloadProblems(script: string): string[] {
  const text = joinContinuations(script);
  const problems: string[] = [];
  if (text.includes("releases/latest/download")) {
    problems.push("downloads from releases/latest/download: an unpinned release asset");
  }
  if (!text.includes("mcp-publisher") || !text.includes("releases/download")) return problems;
  if (!CURL_TO_FILE.test(text) && !WGET_TO_FILE.test(text)) {
    problems.push("downloads mcp-publisher without writing it to a file (curl -o, wget -O) to check");
  }
  const checksum = CHECKSUM_CHECK.exec(text);
  if (checksum === null) {
    problems.push("downloads mcp-publisher without checking it with sha256sum -c or shasum -a 256 -c");
    return problems;
  }
  const exec = PUBLISHER_EXEC.exec(text);
  if (exec !== null && exec.index < checksum.index) {
    problems.push("executes mcp-publisher before the checksum check");
  }
  return problems;
}

/** `pnpm install` (or `pnpm i`) as a command. */
const PNPM_INSTALL = /(?<![\w.-])pnpm\s+(?:install|i)(?=\s|$)/gu;

/** The required flags a script's `pnpm install` commands lack, one entry per command. */
export function pnpmInstallProblems(script: string): { found: boolean; missing: string[][] } {
  const text = joinContinuations(script);
  const missing: string[][] = [];
  let found = false;
  for (const match of text.matchAll(PNPM_INSTALL)) {
    found = true;
    const command = text.slice(match.index).split(COMMAND_END)[0] ?? "";
    const lacking = ["--frozen-lockfile", "--ignore-scripts"].filter(
      (flag) => !new RegExp(`(?:^|\\s)${flag}(?:=true)?(?=\\s|$)`, "u").test(command),
    );
    if (lacking.length > 0) missing.push(lacking);
  }
  return { found, missing };
}

const rule1 = reporter(1);
const rule2 = reporter(2);
const rule3 = reporter(3);
const rule4 = reporter(4);
const rule5 = reporter(5);
const rule6 = reporter(6);
const rule7 = reporter(7);
const rule8 = reporter(8);
const rule9 = reporter(9);
const rule10 = reporter(10);

/** The ten rules, in one table, so a test can run each alone. */
export const RULES: readonly Rule[] = [
  {
    id: 1,
    description: "actions pinned by commit SHA",
    check(input) {
      const findings: Finding[] = [];
      for (const workflow of input.workflows) {
        for (const job of jobsOf(workflow.doc)) {
          if (Object.hasOwn(job.body, "uses")) {
            const problem = usesProblem(job.body["uses"]);
            if (problem !== undefined) findings.push(rule1(workflow.path, `reusable workflow ${problem}`, job.name));
          }
          stepsOf(job.body).forEach((step, index) => {
            if (!Object.hasOwn(step, "uses")) return;
            const problem = usesProblem(step["uses"]);
            if (problem !== undefined) {
              findings.push(rule1(workflow.path, `${stepLabel(step, index)} ${problem}`, job.name));
            }
          });
        }
      }
      for (const action of input.actions) {
        actionSteps(action).forEach((step, index) => {
          if (!Object.hasOwn(step, "uses")) return;
          const problem = usesProblem(step["uses"]);
          if (problem !== undefined) findings.push(rule1(action.path, `${stepLabel(step, index)} ${problem}`));
        });
      }
      return findings;
    },
  },
  {
    id: 2,
    description: "exact package versions in id-token jobs",
    check(input) {
      const findings: Finding[] = [];
      for (const { workflow, job, inherited } of idTokenJobs(input)) {
        stepsOf(job.body).forEach((step, index) => {
          const run = runOf(step);
          if (run === undefined) return;
          for (const install of unpinnedInstalls(run)) {
            const what = install.spec === "" ? install.command : `${install.command} ${install.spec}`;
            findings.push(
              rule2(
                workflow.path,
                `${stepLabel(step, index)} runs ${what}: ${install.problem}${tokenNote(inherited)}`,
                job.name,
              ),
            );
          }
        });
      }
      return findings;
    },
  },
  {
    id: 3,
    description: "no cdxgen in id-token jobs",
    check(input) {
      const findings: Finding[] = [];
      for (const { workflow, job, inherited } of idTokenJobs(input)) {
        stepsOf(job.body).forEach((step, index) => {
          const run = runOf(step);
          if (run?.includes("cdxgen") === true) {
            findings.push(
              rule3(
                workflow.path,
                `${stepLabel(step, index)} mentions cdxgen in a job that can mint a publish token${tokenNote(inherited)}`,
                job.name,
              ),
            );
          }
        });
      }
      return findings;
    },
  },
  {
    id: 4,
    description: "mcp-publisher download pinned and checksum-verified",
    check(input) {
      const findings: Finding[] = [];
      for (const workflow of input.workflows) {
        for (const job of jobsOf(workflow.doc)) {
          stepsOf(job.body).forEach((step, index) => {
            const run = runOf(step);
            if (run === undefined) return;
            for (const problem of downloadProblems(run)) {
              findings.push(rule4(workflow.path, `${stepLabel(step, index)} ${problem}`, job.name));
            }
          });
        }
      }
      for (const action of input.actions) {
        actionSteps(action).forEach((step, index) => {
          const run = runOf(step);
          if (run === undefined) return;
          for (const problem of downloadProblems(run)) {
            findings.push(rule4(action.path, `${stepLabel(step, index)} ${problem}`));
          }
        });
      }
      return findings;
    },
  },
  {
    id: 5,
    description: "release validate job: full clone and strict checks",
    check(input) {
      const release = findWorkflow(input, "release");
      if (release === undefined) return [rule5(RELEASE_WORKFLOW, "release.yml not found: no validate job to grade")];
      const validate = jobsOf(release.doc).find((job) => job.name === "validate");
      if (validate === undefined) return [rule5(release.path, "release.yml has no validate job")];
      const findings: Finding[] = [];
      const steps = stepsOf(validate.body);
      const checkouts = steps.filter((step) => {
        const uses = step["uses"];
        return typeof uses === "string" && uses.startsWith("actions/checkout");
      });
      if (checkouts.length === 0) findings.push(rule5(release.path, "no actions/checkout step", validate.name));
      for (const step of checkouts) {
        const depth = asMapping(step["with"])?.["fetch-depth"];
        if (depth !== 0 && depth !== "0") {
          const label = stepLabel(step, steps.indexOf(step));
          findings.push(
            rule5(
              release.path,
              `${label} (actions/checkout) has fetch-depth ${show(depth)}, not 0: the history scan needs a full clone`,
              validate.name,
            ),
          );
        }
      }
      const commands = new Set<string>();
      for (const step of steps) {
        const run = runOf(step);
        if (run === undefined) continue;
        commands.add(run.trim());
        for (const line of run.split(/\r?\n/u)) commands.add(line.trim());
      }
      for (const required of VALIDATE_RUNS) {
        if (!commands.has(required)) findings.push(rule5(release.path, `does not run ${required}`, validate.name));
      }
      return findings;
    },
  },
  {
    id: 6,
    description: "MCP registry job: needs publish-npm, least privilege",
    check(input) {
      const findings: Finding[] = [];
      const publishes = (job: Job): boolean =>
        stepsOf(job.body).some((step) => /mcp-publisher\s+publish(?=\s|$)/u.test(joinContinuations(runOf(step) ?? "")));
      for (const workflow of input.workflows) {
        for (const job of jobsOf(workflow.doc).filter(publishes)) {
          const needs = job.body["needs"];
          const needed = typeof needs === "string" ? [needs] : asList(needs);
          if (!needed.includes("publish-npm")) {
            findings.push(
              rule6(workflow.path, `needs is ${show(needs)}, which does not include publish-npm`, job.name),
            );
          }
          const permissions = job.body["permissions"];
          if (!deepEqual(permissions, REGISTRY_JOB_PERMISSIONS)) {
            findings.push(
              rule6(
                workflow.path,
                `permissions are ${show(permissions)}, not exactly ${show(REGISTRY_JOB_PERMISSIONS)}`,
                job.name,
              ),
            );
          }
        }
      }
      const release = findWorkflow(input, "release");
      if (release === undefined) {
        findings.push(rule6(RELEASE_WORKFLOW, "release.yml not found: the MCP registry job is missing"));
      } else if (!jobsOf(release.doc).some(publishes)) {
        findings.push(rule6(release.path, "no job's steps run mcp-publisher publish: the MCP registry job is missing"));
      }
      return findings;
    },
  },
  {
    id: 7,
    description: "setup action installs with --frozen-lockfile --ignore-scripts",
    check(input) {
      const findings: Finding[] = [];
      for (const action of input.actions) {
        let installs = false;
        actionSteps(action).forEach((step, index) => {
          const run = runOf(step);
          if (run === undefined) return;
          const { found, missing } = pnpmInstallProblems(run);
          installs ||= found;
          for (const lacking of missing) {
            findings.push(
              rule7(action.path, `${stepLabel(step, index)} runs pnpm install without ${lacking.join(" and ")}`),
            );
          }
        });
        if (isSetupAction(action.path) && !installs)
          findings.push(rule7(action.path, "the setup action runs no pnpm install"));
      }
      if (!input.actions.some((action) => isSetupAction(action.path))) {
        findings.push(rule7(SETUP_ACTION, "the setup action is missing"));
      }
      return findings;
    },
  },
  {
    id: 8,
    description: "CI matrix: three OSes, Node 22 and 24",
    check(input) {
      const ci = findWorkflow(input, "ci");
      if (ci === undefined) return [rule8(CI_WORKFLOW, "ci.yml not found")];
      const job = jobsOf(ci.doc).find((candidate) => candidate.name === "ci");
      if (job === undefined) return [rule8(ci.path, "ci.yml has no ci job")];
      const matrix = asMapping(job.body["strategy"])?.["matrix"];
      if (deepEqual(matrix, CI_MATRIX)) return [];
      return [rule8(ci.path, `matrix is ${show(matrix)}, not ${show(CI_MATRIX)}`, job.name)];
    },
  },
  {
    id: 9,
    description: "engines.node is >=22.19.0",
    check(input) {
      return input.packages.flatMap((manifest) => {
        const node = asMapping(asMapping(manifest.doc)?.["engines"])?.["node"];
        return node === ENGINES_NODE
          ? []
          : [rule9(manifest.path, `engines.node is ${show(node)}, not ${ENGINES_NODE}`)];
      });
    },
  },
  {
    id: 10,
    description: "top-level permissions are contents: read",
    check(input) {
      return input.workflows.flatMap((workflow) => {
        const permissions = asMapping(workflow.doc)?.["permissions"];
        if (deepEqual(permissions, TOP_LEVEL_PERMISSIONS)) return [];
        return [
          rule10(
            workflow.path,
            `top-level permissions are ${show(permissions)}, not exactly ${show(TOP_LEVEL_PERMISSIONS)}: grant wider rights per job`,
          ),
        ];
      });
    },
  },
];

/** Runs `rules` over `input`; the findings come in rule order, then file order. */
export function runRules(input: Input, rules: readonly Rule[] = RULES): Finding[] {
  return rules.flatMap((rule) => rule.check(input));
}

/** The stderr line of a finding. */
export function formatFinding(finding: Finding, rules: readonly Rule[] = RULES): string {
  const description = rules.find((rule) => rule.id === finding.rule)?.description ?? "unknown rule";
  const job = finding.job === undefined ? "" : `job ${finding.job}: `;
  return `${finding.file}: ${job}rule ${String(finding.rule)} (${description}): ${finding.message}`;
}

function readText(repoRoot: string, path: string): string {
  try {
    return readFileSync(join(repoRoot, ...path.split("/")), "utf8");
  } catch (error: unknown) {
    throw new InputError(`${path}: cannot read (${error instanceof Error ? error.message : String(error)})`);
  }
}

function parseYamlMapping(repoRoot: string, path: string): Mapping {
  let doc: unknown;
  try {
    doc = parse(readText(repoRoot, path));
  } catch (error: unknown) {
    if (error instanceof InputError) throw error;
    throw new InputError(`${path}: YAML parse error: ${error instanceof Error ? error.message : String(error)}`);
  }
  const mapping = asMapping(doc);
  if (mapping === undefined) throw new InputError(`${path}: expected a YAML mapping at the top level`);
  return mapping;
}

function parseJson(repoRoot: string, path: string): unknown {
  try {
    return JSON.parse(readText(repoRoot, path));
  } catch (error: unknown) {
    if (error instanceof InputError) throw error;
    throw new InputError(`${path}: JSON parse error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** Reads and parses every file the rules grade. Throws `InputError` on a missing, unreadable or malformed one. */
export function loadInput(repoRoot: string): Input {
  const workflowsDir = join(repoRoot, ...WORKFLOWS_DIR.split("/"));
  if (!isDirectory(workflowsDir)) throw new InputError(`${WORKFLOWS_DIR}/: not found`);
  const workflows = readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/u.test(name) && isFile(join(workflowsDir, name)))
    .sort()
    .map((name) => {
      const path = posix.join(WORKFLOWS_DIR, name);
      return { path, doc: parseYamlMapping(repoRoot, path) };
    });

  const actionsDir = join(repoRoot, ...ACTIONS_DIR.split("/"));
  const actions: ActionFile[] = [];
  if (isDirectory(actionsDir)) {
    for (const name of readdirSync(actionsDir).sort()) {
      const file = ["action.yml", "action.yaml"].find((candidate) => isFile(join(actionsDir, name, candidate)));
      if (file === undefined) continue;
      const path = posix.join(ACTIONS_DIR, name, file);
      actions.push({ path, doc: parseYamlMapping(repoRoot, path) });
    }
  }

  const packages: PackageFile[] = [{ path: "package.json", doc: parseJson(repoRoot, "package.json") }];
  const packagesDir = join(repoRoot, "packages");
  if (isDirectory(packagesDir)) {
    for (const name of readdirSync(packagesDir).sort()) {
      if (!isFile(join(packagesDir, name, "package.json"))) continue;
      const path = posix.join("packages", name, "package.json");
      packages.push({ path, doc: parseJson(repoRoot, path) });
    }
  }

  return { workflows, actions, packages };
}

export function main(argv: readonly string[] = process.argv.slice(2), repoRoot: string = process.cwd()): number {
  if (argv.length > 0) {
    process.stderr.write(`usage: check-workflow-pins (unknown argument ${argv.join(" ")})\n`);
    return 2;
  }

  let input: Input;
  try {
    input = loadInput(repoRoot);
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const findings = runRules(input);
  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`${formatFinding(finding)}\n`);
    process.stderr.write(
      `\nFAIL: ${String(findings.length)} finding(s). The release path pins every action by commit SHA, runs nothing unpinned where it can mint a token, and grants each job only the rights it uses.\n`,
    );
    return 1;
  }
  process.stdout.write(
    `${String(input.workflows.length)} workflow(s), ${String(input.actions.length)} composite action(s), ${String(input.packages.length)} package manifest(s): ${String(RULES.length)} rules, no finding.\n`,
  );
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(main());
}
