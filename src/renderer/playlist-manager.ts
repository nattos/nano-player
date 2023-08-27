import * as utils from './utils';
import * as constants from './constants';
import { makeObservable, observable, runInAction } from 'mobx';
import { Database, UpdateMode } from './database';
import { Track } from './schema';

export class Playlist {
  @observable name: string;
  @observable.shallow entryPaths: string[] = [];

  constructor(public readonly key: string, name: string) {
    this.name = name;
    makeObservable(this);
  }
}

export class PlaylistManager {
  public static get instance() {
    if (!PlaylistManager.instanceField) {
      PlaylistManager.instanceField = new PlaylistManager();
    }
    return PlaylistManager.instanceField;
  }
  private static instanceField?: PlaylistManager;

  private readonly queue = new utils.OperationQueue();

  private readonly playlists = new Map<string, Playlist>();

  constructor() {
    this.queue.push(async () => { await Database.instance.waitForLoad(); });
  }

  getPlaylistNamesDirty(): string[] {
    return Array.from(Database.instance.getPlaylists().map(playlist => playlist.name)).sort();
  }

  async getPlaylist(key: string): Promise<Playlist|undefined> {
    let playlist = this.playlists.get(key);
    if (playlist !== undefined) {
      return playlist;
    }
    return await this.queue.push(async () => {
      let playlist = this.playlists.get(key);
      if (playlist !== undefined) {
        return playlist;
      }
      const entry = Database.instance.getPlaylistByKey(key);
      if (entry === undefined) {
        return undefined;
      }
      playlist = new Playlist(key, entry.name);
      this.playlists.set(key, playlist);

      // Read entries from database.
      playlist.entryPaths = await Database.instance.getPlaylistContainedTrackPaths(key);
      return playlist;
    });
  }

  async updatePlaylist(key: string, newEntryPaths: string[]) {
    return await this.queue.push(async () => {
      let playlist = this.playlists.get(key);
      if (playlist === undefined) {
        throw new Error(`Playlist ${key} not found.`);
      }
      const oldEntryPaths = playlist.entryPaths;

      const allPaths = new Set<string>();
      utils.setAddRange(allPaths, newEntryPaths);
      utils.setAddRange(allPaths, oldEntryPaths);

      await Database.instance.updateTracks(Array.from(allPaths), UpdateMode.UpdateOnly, (trackGetter) => {
        for (const path of oldEntryPaths) {
          const track = trackGetter(path);
          if (track === undefined) {
            continue;
          }
          track.inPlaylists = track.inPlaylists.filter(indexKey => Database.getPlaylistIndexKeyKey(indexKey) !== key);
        }
        let index = 0;
        for (const path of newEntryPaths) {
          const track = trackGetter(path);
          if (track === undefined) {
            continue;
          }
          track.inPlaylists.push(Database.makePlaylistIndexKey(key, index++));
        }
      });
      runInAction(() => {
        playlist!.entryPaths = newEntryPaths;
      });
    });
  }

  async updatePlaylistWithCallback(key: string, updaterFunc: (allEntries: Track[]) => string[]) {
    return await this.queue.push(async () => {
      let playlist = this.playlists.get(key);
      if (playlist === undefined) {
        throw new Error(`Playlist ${key} not found.`);
      }
      const oldEntryPaths = playlist.entryPaths;

      await Database.instance.updateTracks(Array.from(oldEntryPaths), UpdateMode.UpdateOnly, (trackGetter) => {
        const allEntries: Track[] = [];
        for (const path of oldEntryPaths) {
          const track = trackGetter(path);
          if (track === undefined) {
            continue;
          }
          allEntries.push(track);
          track.inPlaylists = track.inPlaylists.filter(indexKey => Database.getPlaylistIndexKeyKey(indexKey) !== key);
        }

        const newEntryPaths = updaterFunc(allEntries);

        let index = 0;
        for (const path of newEntryPaths) {
          const track = trackGetter(path);
          if (track === undefined) {
            continue;
          }
          track.inPlaylists.push(Database.makePlaylistIndexKey(key, index++));
        }

        runInAction(() => {
          playlist!.entryPaths = newEntryPaths;
        });
      });
    });
  }
}


