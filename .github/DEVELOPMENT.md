# Development

Notes for whoever (you, on another machine) touches the repo — not configuration
for any specific subsystem, that lives in `GiGiShell/README.md` and
`GiGiShell/hypr/SETUP.md`.

## File verification before every `git push`

The repo ships a `pre-push` hook that runs automatically on every push and
aborts if it finds something that shouldn't be tracked.

- **`bin/verify-files.sh`** — checks the *real* type of every tracked file by
  its magic bytes (`file -b`), not by extension. This is intentional: the
  `.gitignore` ("Security" section at the top) filters by name/extension, which
  is trivial to dodge by just renaming an executable to `.txt` or `.pdf`. The
  script catches that by checking the actual content: ELF, PE32 (`.exe`),
  Mach-O, Java archive, Microsoft Cabinet, Composite Document File (OLE, the
  format used by old `.doc`/`.xls` files with macros).
- If you have **ClamAV** installed (`clamscan` on PATH), the script also runs
  every file through an actual signature scan. The script distinguishes
  `clamscan`'s exit code: `1` (genuinely infected) blocks the push; any other
  error code (e.g. `2`, "no supported database files found" because
  `freshclam` hasn't been run) just warns and lets it through — a half-configured
  install isn't a security finding. If `clamscan` isn't on PATH at all, same
  treatment: warn and continue, don't block on its absence.
- **`.githooks/pre-push`** is the hook itself; it just invokes
  `bin/verify-files.sh` with no arguments (checks all of `git ls-files`, not
  just the push diff).

### How it gets activated (and why you don't need to install it by hand)

Hooks in `.git/hooks/` don't travel with the repo — that's why they're
versioned under `.githooks/` and activated by pointing `core.hooksPath` there.
That `git config` is local to each clone, so `GiGiShell/bin/link.sh` reapplies it
every time you run it (it's already the standard step for setting up any new
machine, see `GiGiShell/hypr/SETUP.md` §11) — it's not a separate manual step.

If you ever need to do it by hand:

```sh
git config core.hooksPath .githooks
```

### Manual usage

```sh
bin/verify-files.sh              # checks all tracked files
bin/verify-files.sh file.ext     # checks only those files
```

### If the hook blocks something you actually want to track

First confirm the file is legitimate (it's not enough that "I put it there" —
if it came from a download or from someone else, actually check it). If it's
legitimate:

```sh
git add -f file.ext
```

`verify-files.sh` will keep flagging it on the next push because it only looks
at content, not whether it's already staged — that's a deliberate repeated
warning, not a bug.

In a genuine emergency (the hook fails over something unrelated to the file,
e.g. `file` isn't installed) you can skip it with `git push --no-verify`, but
that also skips the file verification, so only use it knowing what you're
skipping.
