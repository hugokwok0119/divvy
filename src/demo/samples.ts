import a1 from '../../scripts/statement-eval/mock-statements/sample-a1.pdf?url';
import a3 from '../../scripts/statement-eval/mock-statements/sample-a3.pdf?url';
import c1 from '../../scripts/statement-eval/mock-statements/sample-c1.pdf?url';
import d1 from '../../scripts/statement-eval/mock-statements/sample-d1.pdf?url';
import f1 from '../../scripts/statement-eval/mock-statements/sample-f1.pdf?url';
import sampleResults from './sample-results.json';

const urls: Record<string, string> = { 'sample-a1': a1, 'sample-a3': a3, 'sample-c1': c1, 'sample-f1': f1, 'sample-d1': d1 };

/** The five featured samples, in card order. */
export const SAMPLE_DOWNLOADS: Array<{ id: string; fileName: string; description: string; url: string }> =
  Object.keys(urls).map((id) => {
    const { fileName, description } = sampleResults.samples.find((s) => s.id === id)!;
    return { id, fileName, description, url: urls[id] };
  });
