import { JoinForm } from '@/components/JoinForm';

export default async function Home({ searchParams }: { searchParams: Promise<{ room?: string }> }) {
  const { room } = await searchParams;
  return (
    <main className="join-page">
      <JoinForm initialRoom={typeof room === 'string' ? room : ''} />
    </main>
  );
}
