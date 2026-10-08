# Shared Cartridge contracts

`botcube-cartridge` owns the framework-neutral Python definitions consumed by
Cartridges and Harness adapters. It requires Python 3.11 or newer and has no
runtime dependencies. Import its types instead of declaring copies:

```python
from botcube_cartridge import HarnessDefinition, InvocationAuth, ModelRelay
```

`HarnessDefinition` describes the Cartridge's skills, agent copy, invocation
identity, shell policy, environment, and root preparation. `InvocationAuth`
returns the invocation's actor, persistence choice, forwarded environment, and
optional model relay. `ModelRelay` carries the Credential Service endpoint and
Turn binding for relayed model calls. The [definitions](src/botcube_cartridge/__init__.py)
are the field reference.

Declare `botcube-cartridge` as a runtime dependency. The
[template package](../template/pyproject.toml) binds it to the sibling `cartridge/`
source directory through `tool.uv.sources`. Use the path appropriate for your
own repository layout; a custom production build must provide that dependency
at its configured path.

The [template staging hook](../template/deploy/stage-tools.sh) copies this
package's source into `.tool-dist/cartridge-contract/`. The narrow-context
[Harness](../harness/deepagents/Dockerfile) and
[session API](../harness/deepagents/session-api.Dockerfile) builds consume it
there. Preserve that staged input in your own tool hook. Credential Service
build contexts that install your Cartridge must include the same neutral
package alongside its other runtime dependencies. The
[template Credential Service Dockerfile](../template/deploy/credential-service/Dockerfile)
shows the public source layout.

These definitions have one owner. The shared acceptance tests exercise both
Cartridges against them, while each Cartridge retains its own sign-in, skills,
model policy, and UI behavior. Generated deployment identity remains governed
by the [template identity guide](../template/IDENTITY.md).
