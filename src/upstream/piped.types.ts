export interface PipedStream {
  url: string;
  format: string;
  quality: string;
  mimeType: string;
  codec: string;
  audioTrackId: string | null;
  audioTrackName: string | null;
  audioTrackType: string | null;
  audioTrackLocale: string | null;
  videoOnly: boolean;
  itag: number;
  bitrate: number;
  initStart: number;
  initEnd: number;
  indexStart: number;
  indexEnd: number;
  width: number;
  height: number;
  fps: number;
  contentLength: number;
}

export interface Streams {
  title: string;
  description: string;
  uploadDate: string;
  uploader: string;
  uploaderUrl: string;
  uploaderAvatar: string;
  thumbnailUrl: string;
  hls: string;
  dash: string;
  lbryId: string | null;
  category: string;
  license: string;
  visibility: string;
  tags: string[];
  metaInfo: any[];
  uploaderVerified: boolean;
  duration: number;
  views: number;
  likes: number;
  dislikes: number;
  uploaderSubscriberCount: number;
  uploaded: number;
  audioStreams: PipedStream[];
  videoStreams: PipedStream[];
  relatedStreams: StreamItem[];
  subtitles: any[];
  livestream: boolean;
  proxyUrl: string;
  chapters: any[];
  previewFrames: any[];
}

export interface StreamItem {
  url: string;
  type: 'stream' | 'channel' | 'playlist';
  title?: string;
  name?: string;
  thumbnail: string;
  uploaderName?: string;
  uploader?: string;
  author?: string;
  uploaderUrl?: string;
  uploaderAvatar?: string;
  uploadedDate?: string;
  shortDescription?: string;
  duration?: number;
  views?: number;
  videos?: number;
  videoCount?: number;
  uploaded?: number;
  uploaderVerified?: boolean;
  isShort?: boolean;
  subscriberCount?: number;
}

export interface Channel {
  id: string;
  name: string;
  avatarUrl: string;
  bannerUrl: string;
  description: string;
  nextpage: string | null;
  subscriberCount: number;
  verified: boolean;
  relatedStreams: StreamItem[]; // Actually usually tracks in top
  tabs: any[];
}

export interface Playlist {
  name: string;
  thumbnailUrl: string;
  description: string;
  bannerUrl: string;
  nextpage: string | null;
  uploader: string;
  uploaderUrl: string;
  uploaderAvatar: string;
  videos: number;
  relatedStreams: StreamItem[];
}

export interface SearchPage {
  items: StreamItem[];
  nextpage: string | null;
  suggestion: string | null;
  corrected: boolean;
}

export interface SuggestionResult {
  suggestions: string[];
}
