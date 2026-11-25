import { commandFields } from './credential-fields.js';
import type { BotCubeConfig } from './schema.js';
import { ALLOW_COMMAND_CREDENTIALS_ENV } from './blocks.js';

/** The standard variables each runtime reads its trust roots from, all pointed at the BotCube Config's `caBundle`. */
export function trustEnvironment({ caBundle }: Pick<BotCubeConfig, 'caBundle'>): Record<string, string> {
  return caBundle === undefined ? {} : { SSL_CERT_FILE: caBundle, NODE_EXTRA_CA_CERTS: caBundle, REQUESTS_CA_BUNDLE: caBundle };
}

/**
 * The opt-in every BotCube process gets, from the deploy environment and never from the BotCube Config: whoever can
 * edit the file chooses a command credential's command, so the operator sets ALLOW_COMMAND_CREDENTIALS_ENV where the
 * deploy runs. Throws, naming each command credential, when the config has one and the operator set nothing.
 */
export function commandCredentialOptIn(config: BotCubeConfig, deployEnvironment: NodeJS.ProcessEnv): Record<string, string> {
  if (deployEnvironment[ALLOW_COMMAND_CREDENTIALS_ENV] === '1') return { [ALLOW_COMMAND_CREDENTIALS_ENV]: '1' };
  const commands = commandFields(config).map((path) => path.join('.'));
  if (commands.length) {
    throw new Error(commands.map((field) => `${field} is a command credential, which runs only when the deploy environment sets ${ALLOW_COMMAND_CREDENTIALS_ENV}=1`).join('\n'));
  }
  return {};
}
