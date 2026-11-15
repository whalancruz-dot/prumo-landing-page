// Gera charts/br.json, o arquivo que o Nyx lê na aba "Em alta". Node 20+, sem dependências.
//
// Fontes:
//  - Netflix Top 10 OFICIAL do Brasil: arquivo público semanal de netflix.com/tudum/top10.
//    (A Netflix só divulga o ranking por semana; ele muda às terças.)
//  - "Em alta hoje" de cada plataforma: ranking diário de tendências do JustWatch para o
//    catálogo de cada serviço no Brasil. As plataformas não divulgam ranking próprio.
//    O JustWatch não tem API pública oficial: se uma consulta falhar, o ranking anterior
//    daquela plataforma é mantido.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const OUT = 'charts/br.json';
const COUNTRY = 'BR';
const NETFLIX_TSV = 'https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv';
const JW = 'https://apis.justwatch.com/graphql';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const PLATFORMS = { netflix: 'nfx', prime: 'prv', disney: 'dnp', max: 'mxx', apple: 'atp', globoplay: 'gop', paramount: 'pmp', crunchyroll: 'cru' };

const NODE = `objectType content(country:$c,language:$l){title originalTitle originalReleaseYear posterUrl externalIds{tmdbId} scoring{imdbScore}}`;
const Q_TREND = `query($c:Country!,$l:Language!,$p:[String!],$t:[ObjectType!]){popularTitles(country:$c,first:10,sortBy:TRENDING,filter:{packages:$p,objectTypes:$t}){edges{node{${NODE}}}}}`;
const Q_SEARCH = `query($c:Country!,$l:Language!,$p:[String!],$t:[ObjectType!],$q:String){popularTitles(country:$c,first:6,filter:{packages:$p,objectTypes:$t,searchQuery:$q}){edges{node{${NODE}}}}}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function jw(query, variables) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(JW, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ query, variables: { c: COUNTRY, l: 'pt', ...variables } }) });
      if (!res.ok) throw new Error(`JustWatch respondeu ${res.status}`);
      const json = await res.json();
      if (json.errors) throw new Error(json.errors[0].message);
      await sleep(250);
      return json.data.popularTitles.edges.map((e) => e.node);
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(1500 * attempt);
    }
  }
}
function entry(node, kind, rank) {
  const c = node.content || {};
  return {
    rank, kind, title: c.title || '', original: c.originalTitle || '',
    year: c.originalReleaseYear ? String(c.originalReleaseYear) : '',
    poster: c.posterUrl ? 'https://images.justwatch.com' + c.posterUrl.replace('{profile}', 's332').replace('{format}', 'jpg') : '',
    tmdbId: c.externalIds && c.externalIds.tmdbId ? String(c.externalIds.tmdbId) : null,
    rating: c.scoring && c.scoring.imdbScore ? Number(c.scoring.imdbScore).toFixed(1) : null,
  };
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/* ---------- Netflix oficial ---------- */
async function netflixOfficial() {
  const res = await fetch(NETFLIX_TSV, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`Netflix respondeu ${res.status}`);
  const lines = (await res.text()).split('\n');
  const col = Object.fromEntries(lines[0].trim().split('\t').map((h, i) => [h, i]));
  for (const need of ['country_iso2', 'week', 'category', 'weekly_rank', 'show_title', 'season_title', 'cumulative_weeks_in_top_10']) {
    if (!(need in col)) throw new Error(`Coluna ausente no TSV da Netflix: ${need}`);
  }
  const rows = [];
  let week = '';
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].replace(/\r$/, '').split('\t');
    if (c[col.country_iso2] !== COUNTRY) continue;
    if (c[col.week] > week) week = c[col.week];
    rows.push(c);
  }
  if (!week) throw new Error('Sem linhas do Brasil no TSV da Netflix');

  const build = async (category, kind) => {
    const list = rows.filter((c) => c[col.week] === week && c[col.category] === category)
      .sort((a, b) => Number(a[col.weekly_rank]) - Number(b[col.weekly_rank]));
    const out = [];
    for (const c of list) {
      const english = c[col.show_title];
      const season = c[col.season_title];
      const base = { rank: Number(c[col.weekly_rank]), kind, title: english, original: '', year: '', poster: '', tmdbId: null, rating: null };
      let found = null;
      try {
        // A Netflix divulga o título internacional; o JustWatch devolve o título em português e a capa.
        const type = [kind === 'movie' ? 'MOVIE' : 'SHOW'];
        const want = norm(english);
        const pickFrom = (nodes) => nodes.find((n) => norm(n.content.title) === want || norm(n.content.originalTitle) === want);
        const inNetflix = await jw(Q_SEARCH, { p: ['nfx'], t: type, q: english });
        found = pickFrom(inNetflix) || inNetflix[0] || pickFrom(await jw(Q_SEARCH, { p: null, t: type, q: english }));
      } catch (e) { console.warn(`  busca falhou para "${english}": ${e.message}`); }
      out.push({
        ...(found ? entry(found, kind, base.rank) : base),
        alt: [english],
        weeks: Number(c[col.cumulative_weeks_in_top_10]) || 1,
        ...(season && season !== 'N/A' ? { season } : {}),
      });
    }
    return out;
  };
  const movies = await build('Films', 'movie');
  const series = await build('TV', 'series');
  if (movies.length < 5 || series.length < 5) throw new Error('Top 10 da Netflix veio incompleto');
  return { week, movies, series };
}

/* ---------- Em alta hoje por plataforma ---------- */
async function trending(pkg) {
  const movies = (await jw(Q_TREND, { p: [pkg], t: ['MOVIE'] })).map((n, i) => entry(n, 'movie', i + 1));
  const series = (await jw(Q_TREND, { p: [pkg], t: ['SHOW'] })).map((n, i) => entry(n, 'series', i + 1));
  if (movies.length < 5 || series.length < 5) throw new Error('lista incompleta');
  return { movies, series };
}

let prev = {};
try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch (e) {}
const today = new Date().toISOString().slice(0, 10);
const out = { country: COUNTRY, official: prev.official || {}, daily: prev.daily || {} };
let fresh = 0;

try {
  out.official.netflix = { ...(await netflixOfficial()), updated: today };
  fresh++;
  console.log(`netflix (oficial): semana ${out.official.netflix.week}`);
} catch (e) { console.warn(`netflix (oficial): mantido o anterior. ${e.message}`); }

for (const [id, pkg] of Object.entries(PLATFORMS)) {
  try {
    out.daily[id] = { ...(await trending(pkg)), updated: today };
    fresh++;
    console.log(`${id}: ok`);
  } catch (e) { console.warn(`${id}: mantido o anterior. ${e.message}`); }
}

if (fresh === 0) throw new Error('Nenhuma fonte respondeu, nada foi gravado');
await mkdir('charts', { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`${OUT} gravado (${fresh} de ${Object.keys(PLATFORMS).length + 1} fontes atualizadas)`);
