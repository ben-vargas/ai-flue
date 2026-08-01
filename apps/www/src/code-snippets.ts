// Prompt copied to the user's clipboard by the "Copy Prompt" CTA in the hero.
export const COPY_PROMPT = `Read https://flueframework.com/start.md then help create my first agent...`;

export const HERO = `export function MyAssistant() {
  const [count, setCount] = usePersistentState('count', 0);
  useAgentStart(() => setCount((n) => n + 1));
  useModel('moonshot/kimi-k2');
  return \`You are a helpful assistant. This conversation has \${count} messages.\`;
}`;
