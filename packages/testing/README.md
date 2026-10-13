# @gripeventsctl/testing

Test helpers shared by the GripEventsCtl packages. This package is **private** (never published) and depends on no other workspace package. A package that uses it adds `"@gripeventsctl/testing": "workspace:^"` under `devDependencies`.

- `withTempHome(fn)`: a fresh temporary directory set as `HOME`, `USERPROFILE` and `GRIPEVENTSCTL_CONFIG_FILE` for one test, removed afterwards.
- `@gripeventsctl/testing/setup`: a Vitest `setupFiles` entry that points those variables at a temporary directory for every test file, fails a test that leaves a resolved config, send log, journal or lock path outside it, and fails the file if the real home directory's `.gripeventsctl*` files changed. No unit test can reach the real home directory.
- `stubOp(script)`: a POSIX shell script named `op` on a temporary directory prepended to `PATH`, recording its argv, stdin and environment for each call and answering from the script. POSIX only.
- `fakeClock()`: a manual `Clock` whose `now()` the test sets and whose `sleep()` resolves when the test advances it.
- `fixtureSecrets()`: a per-run session token, chat token, application token, password and `Basic` value; never a literal in a committed file.
