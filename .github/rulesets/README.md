# Branch-protection rulesets

This directory holds the canonical, version-controlled definitions of the
repository's [GitHub repository rulesets][gh-rulesets]. The files here are the
source of truth; the GitHub-side configuration is a deployed copy and must be
kept in sync with these files manually.

## Files

| File                         | Purpose                                                                                                                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main-protection.json`       | Active production ruleset for `refs/heads/main`. Requires the `CI` status check, rebase-only merges, linear history.                                                                                                                    |
| `main-protection-no-ci.json` | Emergency variant of `main-protection.json` with the `required_status_checks` rule removed. For use when CI is unavailable and a maintainer must merge a fix manually. Re-apply `main-protection.json` immediately after the emergency. |

Both files declare `"name": "main-protection"` — applying one replaces the
other on GitHub.

## Apply a ruleset (push local → GitHub)

Requires `gh` CLI authenticated as a user with admin rights on the repo.

```sh
# Update the existing ruleset by id (preferred — preserves the ruleset id).
RULESET_ID="$(gh api /repos/alexey-pelykh/gripeventsctl/rulesets --jq '.[] | select(.name=="main-protection") | .id')"
gh api -X PUT "/repos/alexey-pelykh/gripeventsctl/rulesets/${RULESET_ID}" \
  --input .github/rulesets/main-protection.json
```

If no `main-protection` ruleset exists yet (fresh fork or after a deletion):

```sh
gh api -X POST /repos/alexey-pelykh/gripeventsctl/rulesets \
  --input .github/rulesets/main-protection.json
```

Use `main-protection-no-ci.json` instead in the emergency path.

## Verify the deployed ruleset matches the file

```sh
RULESET_ID="$(gh api /repos/alexey-pelykh/gripeventsctl/rulesets --jq '.[] | select(.name=="main-protection") | .id')"
gh api "/repos/alexey-pelykh/gripeventsctl/rulesets/${RULESET_ID}" \
  --jq '{name, target, enforcement, bypass_actors, conditions, rules}' > /tmp/ruleset-deployed.json
diff <(jq -S . .github/rulesets/main-protection.json) <(jq -S . /tmp/ruleset-deployed.json)
```

Empty output = deployed configuration matches the file.

## Disaster recovery

To restore the security posture from a fresh clone:

1. `gh auth login` as a repo admin.
2. Run the apply command above with `main-protection.json`.
3. Run the verify command above to confirm the deployed state matches.

[gh-rulesets]: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
