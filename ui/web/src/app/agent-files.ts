import { chatServiceUrl } from "../cartridge/chat-service-url";
import { fileDownloadUrl, uploadFile, type UploadOptions } from "../computer/files-app";

const CHAT_SERVICE_URL = chatServiceUrl();

/** The agent's files, on the Files routes every Cartridge's Chat Service mounts (`botcube-chat/computer-files-routes`). */
export const agentFiles = {
  /** A short-lived URL for one of the agent's files, by the path a reply names it with: `/chart.svg`, percent-encoded. */
  url: (path: string) => fileDownloadUrl(decodeURIComponent(path.slice(1)), { chatServiceUrl: CHAT_SERVICE_URL }),
  /** Uploads a file the user attached to the top of Files; resolves to the path the agent reads it by, such as `/report.csv`. */
  upload: (file: File, options: UploadOptions) => uploadFile(file, options, { chatServiceUrl: CHAT_SERVICE_URL }),
};
