# Customize the template identity

Change `name` in `identity.json`, then regenerate the template inputs from the BotCube repository root.
Install the preparation command's locked dependency first.

```sh
npm ci --prefix template/deploy
node template/deploy/prepare-identity.mjs
```

This updates the UI name, Agent Identity, packaged Harness identity, deployment resource names, and AgentCore project names.
The display name must start with a letter and contain words separated by spaces or hyphens.
The same input also owns the default avatar and theme.
Use an emoji for the avatar and existing UI CSS variables for the theme.

Set your AWS account, region, network IDs, browser assets, domains, and GitHub bindings in `deploy/identity.json`.
The preparation command preserves these settings and generates the AWS targets from its account and region.
Replace placeholder IDs before any deployment.
The template's full manifest describes deployment inputs; it does not supply certificates, browser policies, origin-provider code, or live infrastructure.

Check that generated files match the input before building.

```sh
node template/deploy/prepare-identity.mjs --check
```

In the source workspace, paths start with `botcube/`, and `pnpm check:template-identity` runs the same check, and `pnpm check:pr` includes it.

The template file URL slot resolves `/sample.txt` through `/files/download-url`.
The resulting URL downloads a local sample artifact from the Chat Service.
Unknown files return HTTP 404.
Replace these template-owned routes to serve your agent's files.

Every web UI plugin slot has a working default in `ui/web/src`, drawn with the app's design tokens:

- the tool-result renderer shows `template-cli data` items as a card under the shell call;
- the auxiliary panel floats the live browser over the chat while a Turn drives it, and pops out to the auxiliary view;
- the Computer tab shows the chat's Agent Computer, wakes it, and names who is driving;
- the auth provider and Sign-ins tab link the template site.

Restyle them through the theme, or replace a slot's component in `ui/web/src/index.ts`.
From the public repository root, preview every slot on phone and desktop with
the template Storybook:

```sh
corepack pnpm storybook
```

Screenshot capture requires Playwright Chromium or `CHROMIUM_PATH` pointing to
your Chromium executable. Run `corepack pnpm screenshots:storybook -- <out-dir>`
from the public repository root.

The ECS CDK app also needs the latency event names emitted by your UI.
The template does not include a latency budget file.
Supply your event names through the `webLatencyMoments` context as a JSON array of nonempty strings.
For example, after installing the CDK package dependencies, synthesize the foundation stacks from the repository root with:

```sh
CARTRIDGE_DEPLOY_ROOT="$PWD/template/deploy" BOTCUBE_REPOSITORY_ROOT="$PWD" \
  corepack pnpm --dir infra/ecs/cdk cdk synth -c parked=true \
  -c 'webLatencyMoments=["first-response","tool-result"]'
```

Replace the example names with the moments your UI reports.
This synthesizes storage, egress, health, and latency monitoring without the serving origin.
A serving-origin synthesis additionally requires the certificates, policies, provider code, and origin inputs described above.
Without explicit moments, the CDK app reads `latency-budgets.json` beside the active Cartridge's deploy directory and fails if it is absent.
