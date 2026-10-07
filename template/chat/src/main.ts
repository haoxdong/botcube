import { serveChatService } from 'botcube-chat';
import { templateCartridgeFactory } from './cartridge.js';

let stopComputer: () => Promise<void> = async () => undefined;
const server = serveChatService(
  templateCartridgeFactory(process.env, (stop) => {
    stopComputer = stop;
  })
);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void stopComputer().then(
    () => {
      console.log('Agent Computers asleep');
      server.close();
    },
    (error: unknown) => {
      console.error('Agent Computer task stop failed', error);
      process.exitCode = 1;
      server.close();
    }
  );
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
server.once('close', () => {
  process.off('SIGTERM', stop);
  process.off('SIGINT', stop);
});
