import '../historical/history.css';
import { HistoricalView } from '../historical/HistoricalView';

export const metadata = {
  title: 'History · Isobar',
  description: 'Historical weather reconstructions and map sources.',
};

export default function HistoryPage() {
  return <HistoricalView />;
}
