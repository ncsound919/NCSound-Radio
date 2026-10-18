import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { ArrowLeft, Smartphone } from 'lucide-react'
import { GetAppPanel } from '@/components/get-app-panel'

export const metadata: Metadata = {
  title: 'Get the app | NCSound Radio',
  description:
    'Install NCSound Radio on your phone — Android and iPhone — and listen to the live stream from your home screen.',
}

/**
 * The APK is config, not a constant.
 *
 * When the native Android build exists, point NEXT_PUBLIC_APK_URL at it and the
 * button appears. Host the file off-Vercel (R2 bucket `ncsound-media`, or a
 * GitHub Release) — an APK in the repo would bloat every deploy. Until then the
 * page says no APK is published rather than offering a download that goes
 * nowhere. See apps/station-web/.env.example.
 */
const APK_URL = process.env.NEXT_PUBLIC_APK_URL?.trim() || null

/**
 * GET /download — the site's "get the phone app" page.
 *
 * Deliberately outside the AppShell tabs: this is not a station panel, it is a
 * one-job page a QR code or a share link can point at straight.
 */
export default function DownloadPage() {
  return (
    <div className="flex min-h-screen flex-col bg-studio">
      <header className="border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-3xl items-center px-4 sm:px-6">
          <Link
            href="/"
            aria-label="NCSound Radio — back to the station"
            className="flex items-center gap-2.5 rounded-md transition-opacity hover:opacity-90"
          >
            <Image
              src="/station-logo.png"
              alt="NCSound Radio station logo"
              width={36}
              height={36}
              priority
              className="h-9 w-9 rounded-md"
            />
            <span className="text-base font-bold tracking-tight">NCSound Radio</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to the station
        </Link>

        <div className="mt-6 flex items-center gap-3">
          <Smartphone className="h-6 w-6 text-primary" aria-hidden="true" />
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Get the app</h1>
        </div>

        <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
          NCSound Radio installs straight from this page &mdash; no app store, no
          account. Once it is on your home screen it opens full-screen and plays the
          live stream like any other app.
        </p>

        <div className="mt-8">
          <GetAppPanel />
        </div>

        <section className="mt-8 rounded-lg border border-border/60 bg-card/40 p-4">
          <h2 className="text-sm font-semibold">Android APK</h2>
          {APK_URL ? (
            <>
              <p className="mt-2 text-sm text-muted-foreground">
                Prefer a standalone file? Download the signed APK and sideload it. You
                may need to allow installs from your browser in Android settings.
              </p>
              <a
                href={APK_URL}
                className="mt-4 inline-flex rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
              >
                Download for Android
              </a>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              No APK is published yet. The home-screen install above is the supported
              way to get NCSound on your phone today; a standalone Android build is in
              progress.
            </p>
          )}
        </section>

        <section className="mt-6 rounded-lg border border-border/60 bg-card/40 p-4">
          <h2 className="text-sm font-semibold">Just want to listen?</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The installed app streams the same audio as the site. Head back to the{' '}
            <Link href="/" className="text-primary underline-offset-4 hover:underline">
              live player
            </Link>
            .
          </p>
        </section>
      </main>

      <footer className="mt-auto border-t border-border/60 bg-card/40 backdrop-blur-sm">
        <div className="signal-wave" aria-hidden="true" />
        <div className="mx-auto max-w-3xl px-4 py-6 text-xs text-muted-foreground sm:px-6">
          &copy; {new Date().getFullYear()} NCSound Radio. All bars reserved.
        </div>
      </footer>
    </div>
  )
}
