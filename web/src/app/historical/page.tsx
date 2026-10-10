import './history.css';
import { HistoricalView } from './HistoricalView';

export const metadata = {
  title: 'Historical · Isobar',
  description: 'Historical weather reconstructions and map sources.',
};

export default function HistoricalPage() {
  return <HistoricalView />;
}
