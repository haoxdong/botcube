/** The Chat Service a page calls: the build's `NEXT_PUBLIC_CHAT_SERVICE_URL`, else a local one. */
export const chatServiceUrl = () => process.env.NEXT_PUBLIC_CHAT_SERVICE_URL ?? 'http://localhost:8123';
