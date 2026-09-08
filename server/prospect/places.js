import { config } from '../config.js';
import { fetchWithTimeout } from '../util.js';
import { log } from '../realtime.js';

const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.googleMapsUri',
  'places.primaryTypeDisplayName',
  'nextPageToken',
].join(',');

/**
 * Busca empresas reais no Google Places API (New) por texto livre.
 * Retorna registros crus (ainda sem validacao).
 */
export async function searchPlaces({ segment, region, want }) {
  if (!config.prospect.googleKey) throw new Error('GOOGLE_MAPS_API_KEY nao configurada');

  const results = [];
  const seen = new Set();
  let pageToken = null;
  let page = 0;

  while (results.length < want && page < 5) {
    const body = {
      textQuery: `${segment} em ${region}`,
      languageCode: 'pt-BR',
      regionCode: 'BR',
      pageSize: 20,
      ...(pageToken ? { pageToken } : {}),
    };
    const res = await fetchWithTimeout(
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': config.prospect.googleKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify(body),
      },
      20000
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Google Places ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = await res.json();
    for (const p of data.places ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      results.push({
        externalId: p.id,
        name: p.displayName?.text ?? null,
        phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null,
        website: p.websiteUri ?? null,
        address: p.formattedAddress ?? null,
        rating: p.rating ?? null,
        reviews: p.userRatingCount ?? null,
        category: p.primaryTypeDisplayName?.text ?? null,
        mapsUrl: p.googleMapsUri ?? null,
        businessStatus: p.businessStatus ?? null,
        source: 'google-places',
      });
    }

    pageToken = data.nextPageToken ?? null;
    page++;
    log('prospeccao', `Google Places: pagina ${page}, ${results.length} empresas acumuladas`);
    if (!pageToken) break;
    // O nextPageToken leva ~2s para ficar valido.
    await new Promise((r) => setTimeout(r, 2000));
  }

  return results;
}
