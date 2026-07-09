import 'dotenv/config';
import { runPipeline } from './pipeline';
import { exportToCsv } from './export/csv-export';
import { getAllLeads, getDailyReport } from './db/leads-repo';
import { Prioritaet } from './types';
import { nrwRegions, verticalPresets } from './config/markets';
import { reanalyzeExistingLeads } from './reanalyze-existing';

type Args = Record<string, string | boolean>;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command = 'help', ...rest] = argv;
  const args = parseArgs(rest);

  if (command === 'run') {
    const branche = readString(args, 'branche');
    const stadt = readString(args, 'stadt');
    if (!branche || !stadt) {
      printUsage();
      process.exitCode = 1;
      return;
    }

    const result = await runPipeline({
      branche,
      stadt,
      stadtbezirk: readString(args, 'bezirk') ?? readString(args, 'stadtbezirk'),
      maxResults: readNumber(args, 'max') ?? readNumber(args, 'maxResults') ?? 50,
    }, {
      skipAi: Boolean(args['no-ai']) || Boolean(args.skipAi),
      concurrency: readNumber(args, 'concurrency') ?? 5,
      maxResults: readNumber(args, 'max') ?? readNumber(args, 'maxResults') ?? 50,
    });

    console.log('\nRun abgeschlossen');
    console.log(`Leads: ${result.total} | neu: ${result.inserted} | aktualisiert: ${result.updated} | AI: ${result.aiProcessed} | Fehler: ${result.errors}`);
    return;
  }

  if (command === 'report') {
    console.table(getDailyReport());
    return;
  }

  if (command === 'reanalyze') {
    const result = await reanalyzeExistingLeads();
    console.table(result);
    return;
  }

  if (command === 'export') {
    const prioritaet = readString(args, 'prio') ?? readString(args, 'prioritaet');
    const path = exportToCsv({
      stadt: readString(args, 'stadt'),
      branche: readString(args, 'branche'),
      status: readString(args, 'status'),
      prioritaet: isPrioritaet(prioritaet) ? prioritaet : undefined,
    });
    console.log(`CSV exportiert: ${path}`);
    return;
  }

  if (command === 'list') {
    const leads = getAllLeads({
      stadt: readString(args, 'stadt'),
      branche: readString(args, 'branche'),
      status: readString(args, 'status'),
      prioritaet: readString(args, 'prio') ?? readString(args, 'prioritaet'),
    });
    console.table(leads.map(lead => ({
      name: lead.name,
      branche: lead.branche,
      stadt: lead.stadt,
      score: lead.score_gesamt,
      prio: lead.prioritaet,
      status: lead.status,
      website: lead.website,
    })));
    return;
  }

  if (command === 'presets') {
    console.log('\nTawano Verticals');
    console.table(verticalPresets.map(v => ({
      id: v.id,
      label: v.label,
      terms: v.searchTerms.join(', '),
      deal: v.avgDealValue,
      mrr: v.monthlyRetainer,
    })));
    console.log('\nNRW Regions');
    console.table(nrwRegions.map(r => ({ id: r.id, label: r.label, cities: r.cities.join(', ') })));
    return;
  }

  printUsage();
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const part = argv[i];
    if (!part.startsWith('--')) continue;

    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function readString(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(args: Args, key: string): number | undefined {
  const value = readString(args, key);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isPrioritaet(value: string | undefined): value is Prioritaet {
  return value === 'A' || value === 'B' || value === 'C';
}

function printUsage() {
  console.log(`Tawano Lead-Gen

Commands:
  npm run leadgen -- run --branche "Nagelstudio" --stadt "Berlin" --bezirk "Mitte" --max 25 --no-ai
  npm run leadgen:report
  npm run leadgen:export -- --prio A
  npm run leadgen:list -- --status draft_ready
  npm run leadgen -- reanalyze
  npm run leadgen -- presets
  npm run dev
`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
