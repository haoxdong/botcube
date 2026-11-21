import { startChunkRecovery } from './chunk-recovery';
import { startOpeningRequests } from './opening-requests';
import { chatServiceUrl } from './plugin/chat-service-url';

startChunkRecovery();
startOpeningRequests(chatServiceUrl());
