<!--
GripEventsCtl pull request template. Keep the body brief but answer the gate
checkboxes: they protect the public surface contract and the live-API
verification rule from CLAUDE.md.
-->

## Summary

<!-- One or two sentences. What changed and why. -->

## Gate checklist

- [ ] **CLI/MCP parity**: if this PR adds, renames or removes a CLI command
      (`packages/cli/src/commands/**`) or an MCP tool (`packages/mcp/src/tools/**`),
      the two surfaces stay coupled, or the divergence is declared in
      [`.mcp-exempt.yaml`](../.mcp-exempt.yaml) with a reason.
- [ ] **Writes stay gated**: if this PR adds or changes a call that notifies or
      changes something on the platform (interest, skip, chat, meetings), it runs
      only behind the safe-mode gate, honours `--dry-run`, and appends to the send log.
- [ ] **Live verification**: if this PR adds or changes a request shape against
      `api-prod.grip.events`, the matching page under `docs/api/` carries the date it
      was verified live, and the test plan below names the e2e test or transcript.
- [ ] **No secrets**: no session token, chat token, password or captured response
      with personal data is in any committed file or fixture (`pnpm check-secret-leakage`).
- [ ] **Oracles untouched**: if this PR implements an item that has pre-authored
      `*.oracle.test.ts` files, the diff on those files is empty (or the PR links the
      specification change that moved the assertion first), and `pnpm test:oracles` is green
      for the item's files.

## Test plan

<!-- Bulleted checklist of how the change was verified locally. -->

-

## Notes

<!-- Cross-references, follow-ups, anything reviewers should know. -->
