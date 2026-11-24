# Contributing

Thanks for taking the time to look at `@thunderduck/client`.

## This repository is a mirror

The source of truth for this client lives in Thunderduck's internal monorepo.
This repository is a one-way snapshot: each update replaces the tree with the
current state of the source, as a single commit. That means the history here is
not the development history of the project, and a pull request cannot be merged
directly into it.

## Issues are welcome

Bug reports and feature requests are read here. Please include:

- the client and Node versions (`npm ls @thunderduck/client`, `node -v`);
- the runtime and platform (Node, Bun, Deno; macOS, Linux, Windows);
- what you ran, what you expected, and what happened;
- if relevant, the smallest request and response (with the token removed) that
  reproduces it.

For anything that looks like a security problem, use
[SECURITY.md](SECURITY.md) instead of a public issue.

## Pull requests

Pull requests are welcome as a place to discuss a change, and small fixes are
genuinely useful. If a change is accepted, it is applied to the internal source
and appears in the next snapshot; the pull request is then closed rather than
merged, so don't be surprised if your commit does not appear here verbatim.

Please keep a change focused: one behaviour per pull request, with a test that
fails before it and passes after.

## Development

```bash
npm install
npm run typecheck
npm test        # builds, then runs node:test against a local HTTP stub
```

The test suite needs no token and no network: it starts a `node:http` server on
loopback and points the client at it. If you add a branch that talks to the API,
add a stub test for it rather than a live call.

Keep the package dependency-free at runtime. `devDependencies` are fine; a
runtime `dependencies` entry needs a good reason.

## License

By contributing you agree that your contribution is licensed under the Apache
License 2.0, the license this project uses. See [LICENSE](LICENSE).
