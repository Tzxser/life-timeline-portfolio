import { LifeStoreProvider } from '@/lib/life-store'
import { ThemeProvider } from '@/lib/theme'
import { LifeTimelineApp } from '@/components/life-timeline-app'
import { StartupPreferencesProvider } from '@/lib/startup-preferences'

export default function Page() {
  return (
    <ThemeProvider>
      <StartupPreferencesProvider>
        <LifeStoreProvider>
          <LifeTimelineApp />
        </LifeStoreProvider>
      </StartupPreferencesProvider>
    </ThemeProvider>
  )
}
