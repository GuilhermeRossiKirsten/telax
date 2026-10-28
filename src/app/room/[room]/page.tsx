import { redirect } from 'next/navigation';
import { RoomView } from '@/components/RoomView';
import { normalizeName, normalizeRoom, safeDecode } from '@/lib/validation';

export default async function RoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ room: string }>;
  searchParams: Promise<{ name?: string }>;
}) {
  const room = safeDecode((await params).room);
  const { name } = await searchParams;
  const cleanName = normalizeName(name);
  if (!normalizeRoom(room)) redirect('/');
  if (!cleanName) redirect(`/?room=${encodeURIComponent(room)}`);
  return <RoomView room={room} name={cleanName} />;
}
