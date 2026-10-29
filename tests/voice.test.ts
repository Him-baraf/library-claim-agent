import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectVoice } from '../client/voice';
class Channel {
  readyState = 'open'; bufferedAmount = 0;
  send = vi.fn<(value: string) => void>(); close = vi.fn();
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  event(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  responses() { return this.send.mock.calls.map(([value]) => JSON.parse(value)).filter(value => value.type === 'response.create'); }
}
let channel: Channel;
class Peer {
  connectionState = 'new'; ontrack = null; onconnectionstatechange = null;
  createDataChannel() { channel = new Channel(); return channel; }
  addTrack() {} async createOffer() { return { sdp: 'v=0' }; }
  async setLocalDescription() {} async setRemoteDescription() {} close() {}
}
class AudioOutput { autoplay = false; srcObject = null; async play() {} pause() {} }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  vi.stubGlobal('RTCPeerConnection', Peer); vi.stubGlobal('Audio', AudioOutput);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('v=0', { status: 200 })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const callbacks = () => ({ status: vi.fn(), caption: vi.fn(), correction: vi.fn(async () => ({ ok: true })), shelf: vi.fn(), error: vi.fn(), remote: vi.fn() });
const stream = { getAudioTracks: () => [] } as unknown as MediaStream;
describe('voice response scheduling', () => {
  it('queues evidence speech until an active response ends', async () => {
    const session = await connectVoice('test', stream, callbacks()); channel.onopen?.();
    session.sayContext('The packet is ready.', true);
    expect(channel.responses()).toHaveLength(1);
    channel.event({ type: 'response.done', response: { output: [] } });
    expect(channel.responses()).toHaveLength(2);
    expect(channel.responses()[1].response.instructions).toContain('packet is ready'); session.close();
  });
  it('retains the newest pending cue while the claimant is speaking', async () => {
    const session = await connectVoice('test', stream, callbacks());
    channel.event({ type: 'input_audio_buffer.speech_started' });
    session.sayContext('Old cue', true); session.sayContext('New verified cue', true);
    expect(channel.responses()).toHaveLength(0);
    channel.event({ type: 'input_audio_buffer.speech_stopped' });
    channel.event({ type: 'response.done', response: { output: [] } });
    expect(channel.responses()[0].response.instructions).toContain('New verified cue'); session.close();
  });
  it('delays tool follow-up until the current response is done and deduplicates tool calls', async () => {
    const hooks = callbacks(); const session = await connectVoice('test', stream, hooks); channel.onopen?.();
    const call = { name: 'set_shelf', arguments: JSON.stringify({ shelf_id: 'Shelf 2' }), call_id: 'call2' };
    channel.event({ type: 'response.function_call_arguments.done', ...call });
    expect(channel.responses()).toHaveLength(1);
    channel.event({ type: 'response.done', response: { output: [{ type: 'function_call', ...call }] } });
    expect(channel.responses()).toHaveLength(2); expect(hooks.shelf).toHaveBeenCalledTimes(1); session.close();
  });
  it('clears a throttled update when the session closes', async () => {
    const session = await connectVoice('test', stream, callbacks());
    session.sayContext('First cue', true); channel.event({ type: 'response.done', response: { output: [] } });
    session.sayContext('Delayed cue', true); session.close(); await vi.advanceTimersByTimeAsync(8000);
    expect(channel.responses()).toHaveLength(1);
  });
});
