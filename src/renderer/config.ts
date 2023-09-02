
export class Code {
  static readonly LIBRARY_ORDER_KEY_CODE = `
[
  filePathDirectory(track.filePath ?? ''),
  track.metadata?.album,
  formatIntPadded(track.metadata?.diskNumber ?? 0, 3),
  formatIntPadded(track.metadata?.trackNumber ?? 0, 3),
  track.metadata?.title,
].join('\x00')
`;

  static readonly GROUPING_KEY_CODE = `
[
  track?.metadata?.album,
  filePathDirectory(track.filePath ?? ''),
].join('\x00')
`;
}
