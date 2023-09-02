
export interface Track {
  path: string;
  filePath: string;
  fileHandle?: FileSystemFileHandle;
  metadata?: TrackMetadata;
  generatedMetadata?: GeneratedTrackMetadata;
  addedDate: number;
  indexedDate: number;
  indexedAtLastModifiedDate: number;
  inPlaylists: string[];
  coverArt?: ArtworkRef;
}

export interface TrackMetadata {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  trackNumber?: number;
  trackTotal?: number;
  diskNumber?: number;
  diskTotal?: number;
  duration?: number;
  coverArtSummary?: ArtSummary;
}

export interface GeneratedTrackMetadata {
  librarySortKey?: string;
  groupingKey?: string;
}

export interface ArtSummary {
  color: string;
}

export interface ArtworkRef {
  fromImageFileAtPath?: string;
  fromImageInFileMetadataAtPath?: string;
}

export interface TrackPrefix {
  path: string;
  prefixes: string[];
}

export interface SearchTableEntry extends Track {}

export interface LibraryPathEntry {
  path: string;
  directoryHandle?: FileSystemDirectoryHandle;
  fileHandle?: FileSystemFileHandle;
  indexedSubpaths: string[];
}

export interface PlaylistEntry {
  key: string;
  name: string;
}

export enum SortContext {
  Title = 'title',
  Artist = 'artist',
  Album = 'album',
  Genre = 'genre',
  Index = 'index',
}

export interface LibraryLocation {
  playlistKey: string|null;
  sortContext: SortContext|null,
  index: number|null;
}

export interface Preferences {
  key: string;
}

export enum PreferencesKey {
  User = 'user',
  Player = 'player',
}

export interface PlayerPreferences extends Preferences {
  key: PreferencesKey.Player,
  lastPlayedLocation: LibraryLocation;
}

export interface UserPreferences extends Preferences {
  key: PreferencesKey.User,
}
