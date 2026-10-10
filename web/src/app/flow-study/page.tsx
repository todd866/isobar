import type { Metadata } from 'next';
import { ThemeToggle } from '@/components/ThemeToggle';
import { FlowStudy } from './FlowStudy';
import './flow-study.css';

export const metadata: Metadata = {
  title: 'Vertical motion study · Isobar',
  description: 'Illustrative treatments for showing rising and sinking air beside horizontal wind.',
  robots: { index: false, follow: false },
};

export default function FlowStudyPage() {
  return (
    <>
      <header className="flow-study-heading"><h1>Airflow study</h1><ThemeToggle /></header>
      <FlowStudy />
    </>
  );
}
