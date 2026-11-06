import { startOpeningRequests } from './opening-requests';
import { chatServiceUrl } from './cartridge/chat-service-url';

startOpeningRequests(chatServiceUrl());
