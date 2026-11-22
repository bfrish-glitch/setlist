import { SERVER } from '../config';
import { newKey, type Track } from '../types';
import { sharedAudio } from './audio';
import type { PlaybackEvents, SourceAdapter } from './types';

/** archive.org recordings, played straight from archive.org's download links. */

export interface ArchiveItem {
  id: string;
  title: string;
  artist: string;
  date: string;
  venue: string;
  tracks: { file: string; title: string; track?: number; durationSec?: number; url: string }[];
}

export async function fetchArchiveItem(id: string): Promise<ArchiveItem> {
  const r = await fetch(`${SERVER}/resolve/archive?id=${encodeURIComponent(id)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Couldn’t load that archive.org recording');
  return j as ArchiveItem;
}

export function archiveTracks(item: ArchiveItem): Track[] {
  return item.tracks.map((t) => ({
    key: newKey(),
    source: 'archive',
    sourceId: `${item.id}/${t.file}`,
    title: t.title,
    artist: item.artist || item.title,
    subtitle: [item.date, item.venue].filter(Boolean).join(' · ') || item.title,
    durationSec: t.durationSec,
    streamUrl: t.url,
  }));
}

class ArchiveAdapter implements SourceAdapter {
  id = 'archive' as const;
  name = 'archive.org';
  color = '#9aa7b8';

  status() {
    return 'ready' as const;
  }
  statusNote() {
    return 'No account needed. Taper recordings straight from archive.org.';
  }

  async play(track: Track, ev: PlaybackEvents) {
    const url = track.streamUrl ?? `https://archive.org/download/${track.sourceId}`;
    await sharedAudio.play(url, track.durationSec, ev, 'archive.org file failed to load');
    if (track.startSec) sharedAudio.seek(track.startSec);
  }
  pause() {
    sharedAudio.pause();
  }
  resume() {
    sharedAudio.resume();
  }
  seek(sec: number) {
    sharedAudio.seek(sec);
  }
  stop() {
    sharedAudio.stop();
  }
}

export const archive = new ArchiveAdapter();
