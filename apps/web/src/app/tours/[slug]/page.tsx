import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Breadcrumb, Card, CardContent, SectionHeading, Timeline } from '@pasta/ui';
import { formatDuration } from '@pasta/utils';
import { Check, Clock, Info, MapPin, ShieldCheck, Smartphone } from 'lucide-react';

import { Footer } from '@/components/layout/footer';
import { Navbar } from '@/components/layout/navbar';
import { BookingSidebar } from '@/components/tours/booking-sidebar';
import { TourGallery } from '@/components/tours/tour-gallery';
import { TourCarousel } from '@/components/tours/tour-carousel';
import { api, safely } from '@/lib/api';
import { activeCurrency } from '@/lib/currency.server';

type Params = Promise<{ slug: string }>;

/**
 * Rendered per request rather than pre-rendered: the price shown depends on the
 * currency the visitor chose, so there is no one correct copy of this page to
 * build ahead of time.
 */

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const tour = await safely(api.tours.bySlug(slug), null, 'tours.bySlug');

  if (!tour) return { title: 'Tour not found' };

  return {
    title: tour.title,
    description: tour.description,
    alternates: { canonical: `/tours/${tour.slug}` },
    openGraph: { title: tour.title, description: tour.description, type: 'website' },
  };
}

export default async function TourDetailPage({ params }: { params: Params }) {
  const { slug } = await params;
  const currency = await activeCurrency();
  const tour = await safely(api.tours.bySlug(slug, currency), null, 'tours.bySlug');

  if (!tour) notFound();

  // Every other tour, not the three "related" ones: the section is a slider
  // now, so there is room for the whole catalogue and no reason to pick.
  const { data: catalogue } = await safely(
    api.tours.list({ currency, sort: 'popular', limit: 24 }),
    {
      data: [],
      meta: {
        page: 1,
        limit: 0,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    },
    'tours.list',
  );
  const others = catalogue.filter((item) => item.slug !== tour.slug);

  // The cover leads the gallery wherever it sits in the uploaded order, and the
  // tiles beneath it are the rest (the viewer opens them all) — never the cover a second time.
  const cover = tour.gallery.find((image) => image.isCover) ?? tour.gallery[0];
  const galleryImages = [
    ...(cover ? [cover] : []),
    ...tour.gallery.filter((image) => image.url !== cover?.url),
  ];

  return (
    <>
      <Navbar />

      <main id="main" className="mx-auto max-w-7xl px-4 pb-20 pt-8 sm:px-6 lg:px-8">
        <Breadcrumb
          className="mb-6"
          items={[
            { label: 'Home', href: '/' },
            { label: `${tour.location.split(',')[0]} Tours`, href: '/tours' },
            { label: tour.title },
          ]}
          renderLink={(item) => (
            <Link href={item.href ?? '/'} className="text-muted-foreground hover:text-primary">
              {item.label}
            </Link>
          )}
        />

        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex flex-col gap-10">
            {/* Gallery. The cover leads; the next three sit under it. Each tile
                falls back to the brand gradient when there is no photo for it
                yet, which is what the whole gallery used to be. */}
            <TourGallery
              title={tour.title}
              images={galleryImages}
              fallbackCover={tour.coverImage}
            />

            {/* Title. The one-line subtitle under the H1 was struck from the design. */}
            <div className="flex flex-col gap-5">
              <h1 className="font-display text-balance text-3xl font-semibold sm:text-4xl">
                {tour.title}
              </h1>

              {/* "Instant Confirmation" was struck; the other four badges stay. */}
              <ul className="flex flex-wrap gap-3">
                {[
                  { icon: MapPin, label: tour.location },
                  { icon: Clock, label: formatDuration(tour.durationHours) },
                  { icon: Smartphone, label: 'Mobile Ticket' },
                  { icon: ShieldCheck, label: 'Free Cancellation' },
                ].map(({ icon: Icon, label }) => (
                  <li
                    key={label}
                    className="rounded-field border-border bg-card inline-flex items-center gap-2 border px-4 py-2.5 text-sm"
                  >
                    <Icon className="text-primary size-4" aria-hidden />
                    {label}
                  </li>
                ))}
              </ul>

              <p className="text-muted-foreground max-w-3xl whitespace-pre-line">
                {tour.description}
              </p>
            </div>

            {/* Highlights & inclusions */}
            <div className="grid gap-8 sm:grid-cols-2">
              <section className="flex flex-col gap-4">
                <SectionHeading
                  title="Highlights"
                  align="start"
                  as="h2"
                  className="[&_h2]:text-xl"
                />
                <ul className="flex flex-col gap-2.5">
                  {tour.highlights.map((item) => (
                    <li key={item} className="text-muted-foreground flex gap-2.5 text-sm">
                      <span
                        className="bg-primary mt-1.5 size-1.5 shrink-0 rounded-full"
                        aria-hidden
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </section>

              <section className="flex flex-col gap-4">
                <SectionHeading
                  title="What's Included"
                  align="start"
                  as="h2"
                  className="[&_h2]:text-xl"
                />
                <ul className="flex flex-col gap-2.5">
                  {tour.included.map((item) => (
                    <li key={item} className="text-muted-foreground flex gap-2.5 text-sm">
                      <Check className="text-success mt-0.5 size-4 shrink-0" aria-hidden />
                      {item}
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            <section className="flex flex-col gap-6">
              <SectionHeading title="Tour Plan" align="start" as="h2" className="[&_h2]:text-xl" />
              <Timeline steps={tour.plan} />
            </section>

            <div className="grid gap-8 sm:grid-cols-2">
              <section className="flex flex-col gap-4">
                <SectionHeading
                  title="Meeting Point"
                  align="start"
                  as="h2"
                  className="[&_h2]:text-xl"
                />
                <Card>
                  <CardContent className="flex gap-3 p-5">
                    <MapPin className="text-primary mt-0.5 size-5 shrink-0" aria-hidden />
                    <span>
                      <span className="block font-medium">{tour.meetingPointTitle}</span>
                      <span className="text-muted-foreground block text-sm">
                        {tour.meetingPointAddress}
                      </span>
                    </span>
                  </CardContent>
                </Card>
              </section>

              <section className="flex flex-col gap-4">
                <SectionHeading
                  title="Good to Know"
                  align="start"
                  as="h2"
                  className="[&_h2]:text-xl"
                />
                <ul className="flex flex-col gap-2.5">
                  {tour.goodToKnow.map((item) => (
                    <li key={item} className="text-muted-foreground flex gap-2.5 text-sm">
                      <Info className="text-primary mt-0.5 size-4 shrink-0" aria-hidden />
                      {item}
                    </li>
                  ))}
                </ul>
              </section>
            </div>
            {/* The Cancellation Policy accordion that sat here was struck from the design. */}
          </div>

          <aside>
            <BookingSidebar
              slug={tour.slug}
              priceMinor={tour.priceMinor}
              currency={tour.currency}
              maxTickets={tour.maxTicketsPerTour}
            />
          </aside>
        </div>

        {others.length > 0 ? <TourCarousel title="You might also like" tours={others} /> : null}
      </main>

      <Footer />
    </>
  );
}
