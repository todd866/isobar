'use client';

import { useSearchParams } from 'next/navigation';
import { DecisionDesk } from './DecisionDesk';
import { StorySitting } from './StorySitting';

export function Decide() {
  return useSearchParams().get('story') === '1' ? <StorySitting /> : <DecisionDesk />;
}
