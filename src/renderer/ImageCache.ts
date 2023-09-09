import * as utils from '../utils';
import * as constants from './constants';
import { Track, LibraryPathEntry, ArtworkRef } from './schema';
import { Database, UpdateMode } from './database';
import { MediaIndexer } from './media-indexer';
import { createUrl, revokeUrl } from './paths';

export class ImageCache {
  public static get instance() {
    if (!ImageCache.instanceField) {
      ImageCache.instanceField = new ImageCache();
    }
    return ImageCache.instanceField;
  }
  private static instanceField?: ImageCache;

  private cachedImages = new utils.LruCache<string, string>(constants.IMAGE_CACHE_SIZE, this.evicted.bind(this));
  private imageFetchesInFlight = new Map<string, Promise<string|undefined>>();

  async getImageUrl(artworkRef: ArtworkRef): Promise<string|undefined> {
    const cachedFromImageFileAtPath = artworkRef.fromImageFileAtPath && this.cachedImages.get(artworkRef.fromImageFileAtPath);
    if (cachedFromImageFileAtPath) {
      return cachedFromImageFileAtPath;
    }
    const cachedFromImageInFileMetadataAtPath = artworkRef.fromImageInFileMetadataAtPath && this.cachedImages.get(artworkRef.fromImageInFileMetadataAtPath);
    if (cachedFromImageInFileMetadataAtPath) {
      return cachedFromImageInFileMetadataAtPath;
    }
    await Database.instance.waitForLoad();

    let loadedPath = '';
    let loadFunc: (() => Promise<string|undefined>)|undefined = undefined;
    if (artworkRef.fromImageFileAtPath) {
      loadedPath = artworkRef.fromImageFileAtPath;
      loadFunc = () => this.loadImageFile(loadedPath);
    } else if (artworkRef.fromImageInFileMetadataAtPath) {
      loadedPath = artworkRef.fromImageInFileMetadataAtPath;
      loadFunc = () => this.loadCoverArtFromMetadata(loadedPath);
    }
    if (!loadFunc) {
      return undefined;
    }

    const alreadyInFlight = this.imageFetchesInFlight.get(loadedPath);
    let result: string|undefined = undefined;
    if (alreadyInFlight) {
      result = await alreadyInFlight;
    } else {
      const fetch = loadFunc();
      this.imageFetchesInFlight.set(loadedPath, fetch);
      try {
        result = await fetch;
      } finally {
        this.imageFetchesInFlight.delete(loadedPath);
      }
    }
    if (result === undefined) {
      return undefined;
    }
    this.cachedImages.put(loadedPath, result);
    return result;
  }

  private evicted(imageUrl: string) {
    revokeUrl(imageUrl);
  }

  private async loadImageFile(path: string): Promise<string|undefined> {
    const sourceKey = Database.getPathSourceKey(path);
    const filePath = Database.getPathFilePath(path);
    // TODO: Fix laziness. Centralize permissions.
    const libraryPath = Database.instance.findLibraryPath(sourceKey);
    if (!libraryPath || !libraryPath.directoryHandle) {
      return undefined;
    }

    const permissionResult = await libraryPath.directoryHandle?.queryPermission();
    if (permissionResult !== 'granted') {
      return undefined;
    }

    const imageFile = await utils.getSubpathFile(libraryPath.directoryHandle, filePath);
    if (!imageFile) {
      return undefined;
    }
    return await createUrl(imageFile);
  }

  private async loadCoverArtFromMetadata(path: string): Promise<string|undefined> {
    const sourceKey = Database.getPathSourceKey(path);
    const filePath = Database.getPathFilePath(path);
    // TODO: Fix laziness. Centralize permissions.
    const libraryPath = Database.instance.findLibraryPath(sourceKey);
    if (!libraryPath || !libraryPath.directoryHandle) {
      return undefined;
    }

    const permissionResult = await libraryPath.directoryHandle?.queryPermission();
    if (permissionResult !== 'granted') {
      return undefined;
    }

    const fileWithMetadata = await utils.getSubpathFile(libraryPath.directoryHandle, filePath);
    if (!fileWithMetadata) {
      return undefined;
    }

    const bytes = await MediaIndexer.instance.readCoverArtFromFileMetadata(fileWithMetadata);
    if (!bytes) {
      return undefined;
    }
    return URL.createObjectURL(new Blob([bytes]));
  }
}
