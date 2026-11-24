# Native AOT builds

The native installation compiles Octo's TypeScript entrypoint, coordinator, and job, assessment, and publication workers to machine code with Bun's experimental ahead-of-time compiler. This is different from `bun build --compile --bytecode`, which packages bytecode and retains the JIT. The normal `bun run build` and source development path retain emitted JavaScript and the existing stable Bun requirement.

## Select the compiler

Native builds require the explicitly selected Bun compiler `1.4.6-canary.1+bfda77855`, from source revision [`bfda7785587f737438d24f4a68a060a70071aa8f`](https://github.com/oven-sh/bun/commit/bfda7785587f737438d24f4a68a060a70071aa8f). The build checks that revision and compiles and executes a small semantic probe before building Octo. Stable Bun 1.4.5 accepts unknown build flags, including `--aot`, without producing native AOT code; a successful command exit alone is insufficient proof.

Acquire the official compiler separately and verify its artifact before selecting its absolute path. The installer does not download, replace, or upgrade host Bun. Canary download URLs are mutable: a later canary is a different compiler and requires an explicit pin update and compatibility verification. The verified macOS arm64 snapshot has archive SHA-256 `6ab78b08d4107de17ed8b77921b8ebc84c09a52cc2cf702e974e42ddbd63e64b` and extracted executable SHA-256 `77c4c2d40981e39169eb8f50e031ab5b312a42b5e90112185244559b3d361c75`. These checksums do not describe another architecture. Bun's [native compiler documentation](https://bun.com/docs/compiler/aot) describes its experimental status and compatibility differences.

```sh
export OCTO_AOT_BUN=/absolute/path/to/verified/bun
bun run build
bun run build:native
bun run test:native
```

The standalone build writes `build/octo-manager` and `build/native-compiler.json`. Compilation runs from the source checkout regardless of the caller's working directory. `test:native` relocates the executable and shipped resources into a private release, starts a coordinator with fresh state and an empty credential home, verifies its socket API and physical artifact identity, and exercises bounded IPC rejection in the native workers. A separately compiled probe imports the actual native entrypoint, derives authentication from generated synthetic Codex and AWS credentials, and loads both supported worker providers through their payload-construction boundaries; a sentinel stops execution before transport and failing fetch and AWS SDK `send` guards require zero transport attempts, and AWS instance-metadata discovery is disabled. The probe uses no real credentials, model prompt, or external API call. It closes owned processes and removes its private fixture. This check does not establish provider availability or a performance improvement.

## Install and operate

Commit reviewed source before installing a versioned release. Select native mode explicitly:

```sh
bun scripts/install-local.ts --native --aot-bun "$OCTO_AOT_BUN" --stage-only
bun scripts/install-local.ts --native --aot-bun "$OCTO_AOT_BUN" --codex
```

`--aot-bun` or `OCTO_AOT_BUN` also selects native mode. `--native` alone can reuse an existing matching native release; creating one requires the compiler. The ordinary installer path remains interpreted. Native and interpreted releases have separate directories; selecting one does not rewrite the other. Staging and promotion retain the [native activation and checkpoint safeguards](local-install.md).

Native launchers and services execute the binary directly. Its resources and release metadata are resolved beside that physical executable, independently of the source checkout and caller's working directory. The Go dashboard stays a separate native binary. Production dependencies and emitted JavaScript remain in the release for the existing Pi login command and inspectable resources. `login` still invokes the environment's supported stable Bun with the shipped Pi CLI; native installation therefore retains that Bun requirement.

Bun's native compiler makes built-in prototypes read-only and interprets some dynamically generated code, including validator code that cannot be resolved at build time. Octo retains its validators and validation contracts. Native compilation alone does not establish lower steady-state CPU usage; compare the same workload and operational state before making that claim. Native compiler upgrades require fresh build, integration, review, and rollout evidence; the stable development and CI gates remain in force.
