import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraPreview } from './CameraPreview';

describe('camera preview', () => {
  const getUserMedia = vi.fn();
  const track = {
    readyState: 'live' as 'live' | 'ended',
    stop: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getSettings: () => ({ width: 1280, height: 720 }),
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;

  beforeEach(() => {
    track.readyState = 'live';
    track.stop.mockReset();
    track.addEventListener.mockReset();
    track.removeEventListener.mockReset();
    getUserMedia.mockReset();
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    getUserMedia.mockResolvedValue(stream);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('requests only video after a click and releases it on stop', async () => {
    render(<CameraPreview />);
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '켜기' }));
    await screen.findByRole('button', { name: '끄기' });
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    const video = screen.getByLabelText('실시간 웹캠 미리보기') as HTMLVideoElement;
    expect(video.srcObject).toBe(stream);
    fireEvent.click(screen.getByRole('button', { name: '끄기' }));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
  });

  it('shows a recoverable permission error', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    render(<CameraPreview />);
    fireEvent.click(screen.getByRole('button', { name: '켜기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('카메라 권한');
    expect(screen.getByRole('button', { name: '다시 켜기' })).toBeEnabled();
  });

  it('stops a stream that arrives after leaving the page', async () => {
    let resolveStream: (value: MediaStream) => void = () => undefined;
    getUserMedia.mockReturnValueOnce(
      new Promise<MediaStream>((resolve) => {
        resolveStream = resolve;
      }),
    );
    render(<CameraPreview />);
    fireEvent.click(screen.getByRole('button', { name: '켜기' }));
    expect(screen.getByRole('button', { name: '요청 취소' })).toBeEnabled();
    fireEvent.pageHide(window);
    await act(async () => resolveStream(stream));
    await waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '켜기' })).toBeEnabled();
  });

  it('rejects an already-ended camera track instead of showing it as playing', async () => {
    track.readyState = 'ended';
    render(<CameraPreview />);
    fireEvent.click(screen.getByRole('button', { name: '켜기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('카메라 연결이 종료');
    expect(screen.queryByRole('button', { name: '끄기' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 켜기' })).toBeEnabled();
    expect(track.stop).toHaveBeenCalled();
    expect(
      (screen.getByLabelText('실시간 웹캠 미리보기') as HTMLVideoElement).srcObject,
    ).toBeNull();
  });

  it('shows a recoverable error when the active device ends', async () => {
    let ended: () => void = () => undefined;
    track.addEventListener.mockImplementation((type, handler) => {
      if (type === 'ended') ended = () => handler(new Event('ended'));
    });
    render(<CameraPreview />);
    fireEvent.click(screen.getByRole('button', { name: '켜기' }));
    await screen.findByRole('button', { name: '끄기' });
    track.readyState = 'ended';
    act(() => ended());
    expect(await screen.findByRole('alert')).toHaveTextContent('카메라 연결이 종료');
    expect(screen.getByRole('button', { name: '다시 켜기' })).toBeEnabled();
    expect(
      (screen.getByLabelText('실시간 웹캠 미리보기') as HTMLVideoElement).srcObject,
    ).toBeNull();
  });

  it('detects a track that ended before a pending video playback resolved', async () => {
    let finishPlayback: () => void = () => undefined;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPlayback = resolve;
        }),
    );
    render(<CameraPreview />);
    fireEvent.click(screen.getByRole('button', { name: '켜기' }));
    const video = screen.getByLabelText('실시간 웹캠 미리보기') as HTMLVideoElement;
    await waitFor(() => expect(video.srcObject).toBe(stream));
    track.readyState = 'ended';
    await act(async () => finishPlayback());
    expect(await screen.findByRole('alert')).toHaveTextContent('카메라 연결이 종료');
    expect(video.srcObject).toBeNull();
  });

  it('does not let an old permission response replace a newer camera stream', async () => {
    const oldTrack = {
      ...track,
      stop: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const oldStream = {
      getTracks: () => [oldTrack],
      getVideoTracks: () => [oldTrack],
    } as unknown as MediaStream;
    let finishOld: (value: MediaStream) => void = () => undefined;
    getUserMedia.mockReturnValueOnce(
      new Promise<MediaStream>((resolve) => {
        finishOld = resolve;
      }),
    );
    render(<CameraPreview />);
    fireEvent.click(screen.getByRole('button', { name: '켜기' }));
    fireEvent.click(screen.getByRole('button', { name: '요청 취소' }));
    fireEvent.click(screen.getByRole('button', { name: '켜기' }));
    await screen.findByRole('button', { name: '끄기' });
    await act(async () => finishOld(oldStream));
    expect(oldTrack.stop).toHaveBeenCalled();
    expect((screen.getByLabelText('실시간 웹캠 미리보기') as HTMLVideoElement).srcObject).toBe(
      stream,
    );
    expect(screen.getByRole('button', { name: '끄기' })).toBeEnabled();
  });

  it('leaves the requesting state if permission resolves while the document is hidden', async () => {
    let finishRequest: (value: MediaStream) => void = () => undefined;
    getUserMedia.mockReturnValueOnce(
      new Promise<MediaStream>((resolve) => {
        finishRequest = resolve;
      }),
    );
    render(<CameraPreview />);
    fireEvent.click(screen.getByRole('button', { name: '켜기' }));
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => finishRequest(stream));
    expect(screen.getByRole('button', { name: '켜기' })).toBeEnabled();
    expect(track.stop).toHaveBeenCalled();
    expect(
      (screen.getByLabelText('실시간 웹캠 미리보기') as HTMLVideoElement).srcObject,
    ).toBeNull();
  });

  it('releases playback and clears the video if the document becomes hidden before playback resolves', async () => {
    let finishPlayback: () => void = () => undefined;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPlayback = resolve;
        }),
    );
    render(<CameraPreview />);
    fireEvent.click(screen.getByRole('button', { name: '켜기' }));
    const video = screen.getByLabelText('실시간 웹캠 미리보기') as HTMLVideoElement;
    await waitFor(() => expect(video.srcObject).toBe(stream));
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => finishPlayback());
    expect(screen.getByRole('button', { name: '켜기' })).toBeEnabled();
    expect(track.stop).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
  });
});
