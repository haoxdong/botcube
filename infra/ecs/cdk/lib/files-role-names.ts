import type { ChatStorageStack } from './chat-storage-stack.js';
import type { DeployIdentity } from './production-identity.js';

/** The roles that mount a supplied file system, by the names the operator's grants on it give them before the first deploy. */
export function suppliedFilesRoleNames({ suppliedFiles }: ChatStorageStack, { chatServiceTaskRole, filesMountRole, filesLinksRole, agentComputerBrowserRole }: DeployIdentity['aws']['iam']) {
  if (!suppliedFiles) return undefined;
  const required = (field: string, name: string | undefined) => {
    if (!name) throw new Error(`Deploy identity aws.iam.${field}: required with supplied.files, whose grants name the role`);
    return name;
  };
  return {
    chatServiceTaskRole: required('chatServiceTaskRole', chatServiceTaskRole),
    links: { mount: required('filesMountRole', filesMountRole), links: required('filesLinksRole', filesLinksRole) },
    agentComputerBrowserRole: required('agentComputerBrowserRole', agentComputerBrowserRole),
  };
}
