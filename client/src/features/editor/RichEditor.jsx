import { useEffect } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'
import Placeholder from '@tiptap/extension-placeholder'
import { Bold, Code, Heading1, Heading2, Heading3, Italic, List, ListOrdered, Minus, Quote, Redo2, SquareCode, Strikethrough, Undo2 } from 'lucide-react'

// The ProseMirror document is bound to a Y.XmlFragment. y-prosemirror turns
// every transaction into Yjs operations, so formatting and structure merge
// as a CRDT too, not just characters. Undo/redo comes from Y.UndoManager
// and only tracks local changes: you never undo a collaborator's typing.
export default function RichEditor({ session, user, readOnly }) {
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ history: false }),
        Collaboration.configure({ document: session.ydoc, field: 'content' }),
        CollaborationCursor.configure({
          provider: session.provider,
          user: { name: user.name, color: user.color, id: user.id },
        }),
        Placeholder.configure({ placeholder: 'Start writing, or open this page in another window to edit together…' }),
      ],
      editable: !readOnly,
    },
    [session],
  )

  useEffect(() => {
    editor?.setEditable(!readOnly)
  }, [editor, readOnly])

  if (!editor) return null

  const btn = (Icon, cmd, active, title) => (
    <button
      className={`tool ${active ? 'active' : ''}`}
      title={title}
      aria-label={title}
      onMouseDown={(e) => {
        e.preventDefault()
        cmd()
      }}
      disabled={readOnly}
    >
      <Icon size={16} strokeWidth={1.75} />
    </button>
  )
  const chain = () => editor.chain().focus()

  return (
    <div className="rich-editor">
      {!readOnly && (
        <div className="editor-toolbar">
          {btn(Undo2, () => chain().undo().run(), false, 'Undo your changes (Ctrl+Z)')}
          {btn(Redo2, () => chain().redo().run(), false, 'Redo (Ctrl+Shift+Z)')}
          <span className="tool-sep" />
          {btn(Heading1, () => chain().toggleHeading({ level: 1 }).run(), editor.isActive('heading', { level: 1 }), 'Heading 1')}
          {btn(Heading2, () => chain().toggleHeading({ level: 2 }).run(), editor.isActive('heading', { level: 2 }), 'Heading 2')}
          {btn(Heading3, () => chain().toggleHeading({ level: 3 }).run(), editor.isActive('heading', { level: 3 }), 'Heading 3')}
          <span className="tool-sep" />
          {btn(Bold, () => chain().toggleBold().run(), editor.isActive('bold'), 'Bold (Ctrl+B)')}
          {btn(Italic, () => chain().toggleItalic().run(), editor.isActive('italic'), 'Italic (Ctrl+I)')}
          {btn(Strikethrough, () => chain().toggleStrike().run(), editor.isActive('strike'), 'Strikethrough')}
          {btn(Code, () => chain().toggleCode().run(), editor.isActive('code'), 'Inline code')}
          <span className="tool-sep" />
          {btn(List, () => chain().toggleBulletList().run(), editor.isActive('bulletList'), 'Bulleted list')}
          {btn(ListOrdered, () => chain().toggleOrderedList().run(), editor.isActive('orderedList'), 'Numbered list')}
          {btn(Quote, () => chain().toggleBlockquote().run(), editor.isActive('blockquote'), 'Quote')}
          {btn(SquareCode, () => chain().toggleCodeBlock().run(), editor.isActive('codeBlock'), 'Code block')}
          {btn(Minus, () => chain().setHorizontalRule().run(), false, 'Divider')}
        </div>
      )}
      <div className="editor-scroll">
        <EditorContent editor={editor} className="prose" />
      </div>
    </div>
  )
}
