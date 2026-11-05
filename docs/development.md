# Development

Requirements: Node 22 or newer, and Docker for the integration and end-to-end tests.

```bash
npm install
npm run build      # dist/extension.js + dist/webview/
npm run watch      # rebuild on change; press F5 to launch the Extension Development Host
```

`scripts/build.mjs` bundles the extension (Node, CommonJS) and the two webviews (browser, IIFE) with esbuild.
`npm run package` creates a production `iremote-<version>.vsix`.

## Checks and tests

| Command | What it runs |
|---|---|
| `npm run typecheck` | `tsc` for the extension and for `webview/` |
| `npm run lint` | ESLint over `src`, `webview`, `test` |
| `npm run test:unit` | `test/unit` — no servers needed |
| `npm test` | typecheck + unit tests |
| `npm run test:integration` | `test/integration` — every protocol against the Docker servers, plus Deployer/Sync |
| `npm run test:e2e` | `test/e2e` — mocha inside a downloaded VS Code against the SFTP server |

Tests are bundled into `out-test/` by `scripts/build-tests.mjs` and run with Node's built-in test runner (unit and
integration) or `@vscode/test-cli` (e2e, configured in `.vscode-test.mjs`). To run one file or one test:

```bash
node scripts/build-tests.mjs && node --test out-test/unit/PathMapper.test.js
node scripts/build-tests.mjs && node --test --test-name-pattern="longest local mapping" "out-test/unit/**/*.test.js"
```

Pass test files as quoted globs, not as a directory: Node 22 does not accept a directory.

### Test servers

```bash
npm run test:servers:up     # also creates the throw-away SSH key in test/fixtures/
npm run test:servers:down
```

| Server | Port | Image | Notes |
|---|---|---|---|
| SFTP | 2222 | `atmoz/sftp` | password and key login, writable dir `/upload` |
| FTP / FTPS | 2121 | ProFTPD (`test/proftpd`) | MLSD, explicit TLS with a self-signed certificate |
| FTP | 2122 | `delfer/alpine-ftp-server` | vsftpd, LIST only |
| WebDAV | 8080 | `rclone/rclone` | basic auth |

All use user `tester`, password `pass`. Integration tests wait for each server's greeting before connecting,
because Docker accepts the port before the server inside the container is ready.

`examples/demo` is a small project already configured for these servers: `code examples/demo`.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests:

- **check** — typecheck, lint, unit tests and packaging on Linux, Windows and macOS. The Linux `.vsix` is kept as an
  artifact.
- **integration** — Docker servers, integration tests and e2e tests (`xvfb-run`) on Linux. On failure the server logs
  are printed and the VS Code logs (including the iRemote debug trace) are uploaded as the `e2e-vscode-logs` artifact.

## Releasing

`.github/workflows/release.yml` runs when a `v*` tag is pushed. It checks that the tag matches `package.json`
`version`, runs the tests, packages the `.vsix`, and then:

- publishes to the **Visual Studio Marketplace** with Trusted Publishing (`vsce publish --oidc`) — no token is stored.
  The `itemcoder` publisher needs a Trusted Publishing policy for repository `mahbubur001/iremote`, workflow
  `release.yml`, no environment;
- publishes to **Open VSX** when the `OVSX_PAT` repository secret is set (skipped with a warning otherwise);
- creates a GitHub Release with the `.vsix` attached.

```bash
# bump "version" in package.json and add a CHANGELOG.md entry, commit, then:
git tag v1.0.1 && git push origin v1.0.1
```
