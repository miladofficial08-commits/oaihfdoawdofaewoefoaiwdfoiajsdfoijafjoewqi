import assert from 'node:assert/strict';
import { scoreLead } from '../src/scorer/scoring';

export function testScoringPhoneDependentLead() {
  const result = scoreLead({
    name: 'Muster SHK',
    branche: 'SHK',
    stadt: 'Berlin',
    telefon: '030 123456',
    hat_website: 1,
    hat_chatbot: 0,
    hat_online_buchung: 0,
    hat_notdienst_hinweis: 1,
  });

  assert.equal(result.prioritaet, 'A');
  assert.ok(result.telefon >= 90);
}

export function testScoringPenalizesMissingContactPath() {
  const result = scoreLead({
    name: 'Kontaktlos GmbH',
    branche: 'Kosmetikstudio',
    stadt: 'Berlin',
    hat_website: 0,
  });

  assert.equal(result.prioritaet, 'B');
  assert.ok(result.gesamt < 70);
}
