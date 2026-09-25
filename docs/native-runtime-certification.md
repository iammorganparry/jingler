# Native runtime release certification

Normal `pnpm test`/CI retains the fake Claude, Codex and OpenCode protocol suites.
Live certification is opt-in and never runs for a pull request. It makes two paid
turns per cell through Jingler's actual adapter: discovery, prompt, then native
resume using the same continuation ID. It does not certify every tool or model.

`config/native-runtime-certification.json` defines six cells:

| Runtime | Minimum | Current |
| --- | --- | --- |
| Claude | 2.1.282 | npm `latest`, resolved to an exact version at dispatch |
| Codex | 0.153.2 | npm `latest`, resolved to an exact version at dispatch |
| OpenCode | 1.18.14 | npm `latest`, resolved to an exact version at dispatch |

Codex and OpenCode currently support exactly their minimum version. A newer
current version must fail certification until the adapter/protocol pin is reviewed
and updated. Do not downgrade the current cell to make a release pass. The compact
artifact records the actual CLI version; `latest` is never accepted as evidence.

Install syntax checked against official docs on 2026-09-25:
[Claude npm installation](https://code.claude.com/docs/en/setup#install-with-npm),
[Codex installation](https://github.com/openai/codex#installing-and-running-codex-cli),
and [OpenCode installation](https://opencode.ai/docs/#install).
The workflow resolves only `npm view <package>@<version-or-latest> version --json`
and installs that exact version into a temporary prefix. It does not dump schemas.

Run the manual Native runtime certification workflow from the release commit.
Use dedicated Linux self-hosted runners labeled `native-runtime-certification`,
protected by the `native-runtime-certification` environment. Configure that environment's
deployment-branch policy to allow only the repository's protected default branch; the
job independently rejects every other ref. Operators must sign in using each vendor's CLI on those runners beforehand (Claude first-party subscription,
Codex CLI login, and an authenticated OpenCode provider). Keep runner access limited
to trusted release operators; do not reuse these runners for untrusted PR jobs.
There are no workflow credential-file upload/download steps and no vendor token
secrets are required by this workflow. Credentials stay under vendor CLI ownership.
Do not print, copy, parse or include them in an artifact. Isolate concurrent runner
accounts when their vendor CLIs cannot safely share authentication state.

For a local run on a clean checkout with the exact CLI installed and authenticated:

```sh
JINGLER_NATIVE_CERTIFY=1 JINGLER_NATIVE_EXPECTED_VERSION=2.1.282 \
  pnpm certify:native claude minimum
```

Each turn has a two-minute timeout, denies requested tools, and runs in a disposable
repository. Output contains only schema revision, git commit, runtime, matrix slot,
CLI version, status, check names and timestamp. Failures emit a generic message;
inspect the CLI locally rather than uploading logs. The live run must be repeated
after any code change. Review costs and authentication before opting in.

Release requires both the existing successful PI workflow run and the successful
native workflow run for the release input commit. The gate verifies native workflow
identity, all six unique cells, exact minimum versions, successful checks and commit
ownership. Certification applies to the tested input commit; the existing release
workflow subsequently creates its version-bump commit. Live credentials and network
access are intentionally unavailable in ordinary fake-protocol CI.
