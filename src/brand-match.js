import config from '../brands.json' with { type: 'json' };

export const brandKey = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function verifiedBrandItem(item, query) {
  const definition = config.brands.find(brand => brandKey(brand.query) === brandKey(query));
  const accepted = [query, ...(definition?.aliases || [])].map(brandKey);
  // The seller's declared field wins over keywords in title/description.
  const declared = String(item?.brand || String(item?.details || '').split(' · ')[0] || '').trim();
  if (!declared || !accepted.includes(brandKey(declared))) return null;
  return { ...item, brand: query };
}
