import { Routes, Route } from "react-router";
import Layout from "@/components/Layout";
import Home from "@/pages/Home";
import Materials from "@/pages/Materials";
import Notes from "@/pages/Notes";
import NoteEditor from "@/pages/NoteEditor";
import Settings from "@/pages/Settings";
import Narrative from "@/pages/Narrative";

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/materials" element={<Materials />} />
        <Route path="/notes" element={<Notes />} />
        <Route path="/notes/:id" element={<NoteEditor />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/narrative" element={<Narrative />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </Layout>
  );
}
