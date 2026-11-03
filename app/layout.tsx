import type { Metadata, Viewport } from 'next'
import { Noto_Serif_SC, Geist_Mono } from 'next/font/google'
import './globals.css'
import '@/components/schedules/schedules.css'

const notoSerif = Noto_Serif_SC({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-noto-serif',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
})

export const metadata: Metadata = {
  title: 'Life Timeline — 我的人生时间轴',
  description: '一个用于长期记录、浏览和回顾个人一生经历的本地化人生时间轴软件。',
  icons: {
    icon: [{ url: '/life-timeline-icon-32.png', type: 'image/png' }],
    apple: '/life-timeline-icon-256.png',
  },
}

// 主题由用户在应用内显式选择(亮色 / 暗色 / 护眼),themeColor 只需覆盖深浅两种系统偏好
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf9f6' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1a17' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    /* suppressHydrationWarning:主题类由下面的预绘制脚本在 hydration 之前写入 <html>。
       服务端无法预知用户选过哪个主题,这里的 className 差异是预期行为。 */
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={`bg-background ${notoSerif.variable} ${geistMono.variable}`}
    >
      <head>
        {/*
          在首次绘制前确定主题,避免刷新时闪一下别的配色。
          没有存过选择时,跟随系统的深浅偏好。
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('life-timeline-theme');if(t!=='light'&&t!=='dark'&&t!=='eyecare'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.classList.add(t)}catch(e){document.documentElement.classList.add('light')}})()`,
          }}
        />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  )
}
