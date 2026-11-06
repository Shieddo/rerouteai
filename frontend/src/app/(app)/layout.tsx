import { ChatWidget } from "@/components/ChatWidget";
import { Header } from "@/components/Header";

// Shell for signed-in product pages: header, narrow content column and the assistant.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <main className="app-main">
        <Header />
        {children}
      </main>
      <ChatWidget />
    </>
  );
}
