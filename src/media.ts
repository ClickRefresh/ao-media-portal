export type MediaKind = 'photo' | 'video'

export type MediaItem = {
  id: string
  key?: string
  name: string
  kind: MediaKind
  src: string
  collection: string
  dimensions: string
  size: string
  uploaded: string
  tags: string[]
  favorite?: boolean
}

export const initialMedia: MediaItem[] = [
  {
    id: 'american-hero',
    name: 'south-fork-summer-hero.jpg',
    kind: 'photo',
    src: '/demo-media/american-river-rafting.jpg',
    collection: 'American River',
    dimensions: '2400 × 1260',
    size: '8.4 MB',
    uploaded: 'Sep 16, 2026',
    tags: ['rafting', 'summer', 'homepage'],
    favorite: true,
  },
  {
    id: 'cherry-leap',
    name: 'cherry-creek-lewis-leap.jpg',
    kind: 'photo',
    src: '/demo-media/cherry-creek_lewis-leap-charter.jpg',
    collection: 'Cherry Creek',
    dimensions: '2400 × 1260',
    size: '11.2 MB',
    uploaded: 'Sep 14, 2026',
    tags: ['advanced', 'rapid', 'charter'],
  },
  {
    id: 'tuolumne-camp',
    name: 'tuolumne-riverside-camp.webp',
    kind: 'photo',
    src: '/demo-media/tuolumne-camp.webp',
    collection: 'Tuolumne River',
    dimensions: '1920 × 1080',
    size: '4.8 MB',
    uploaded: 'Sep 12, 2026',
    tags: ['camping', 'multiday', 'scenic'],
    favorite: true,
  },
  {
    id: 'kaweah-hero',
    name: 'kaweah-spring-run.webp',
    kind: 'photo',
    src: '/demo-media/overview-hero.webp',
    collection: 'Kaweah River',
    dimensions: '2048 × 1152',
    size: '5.1 MB',
    uploaded: 'Sep 10, 2026',
    tags: ['spring', 'rafting', 'website'],
  },
  {
    id: 'tuolumne-video',
    name: 'tuolumne-trip-overview.mp4',
    kind: 'video',
    src: '/demo-media/tuolumne-river.jpg',
    collection: 'Tuolumne River',
    dimensions: '4K · 02:18',
    size: '486 MB',
    uploaded: 'Sep 8, 2026',
    tags: ['video', 'multiday', 'marketing'],
  },
  {
    id: 'merced-scenery',
    name: 'merced-poppy-canyon.webp',
    kind: 'photo',
    src: '/demo-media/merced-river-scenery.webp',
    collection: 'Merced River',
    dimensions: '1600 × 900',
    size: '3.7 MB',
    uploaded: 'Sep 5, 2026',
    tags: ['scenery', 'spring', 'wildflowers'],
  },
]

export const collections = [
  { name: 'American River', count: 384, color: '#2d6f92' },
  { name: 'Tuolumne River', count: 219, color: '#3e6f52' },
  { name: 'Cherry Creek', count: 156, color: '#985240' },
  { name: 'Merced River', count: 128, color: '#7e663a' },
]
