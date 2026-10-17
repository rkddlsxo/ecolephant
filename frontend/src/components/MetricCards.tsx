import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { usePreferences } from '../state/preferences';

interface Card {
  id: string;
  label: string;
  value: string;
  help: string;
}
function SortableCard({ card }: { card: Card }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: card.id });
  return (
    <div
      ref={setNodeRef}
      className="metric-card"
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <span>{card.label}</span>
      <strong>{card.value}</strong>
      <small>{card.help}</small>
      <button
        className="drag-handle"
        aria-label={`${card.label} 카드 순서 변경`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={17} />
      </button>
    </div>
  );
}
export function MetricCards({ cards }: { cards: Card[] }) {
  const order = usePreferences((s) => s.cardOrder),
    setOrder = usePreferences((s) => s.setCardOrder);
  const ids = [
    ...order.filter((id) => cards.some((c) => c.id === id)),
    ...cards.map((c) => c.id).filter((id) => !order.includes(id)),
  ];
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={({ active, over }) => {
        if (over && active.id !== over.id)
          setOrder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
      }}
    >
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <div className="metric-grid">
          {ids.map((id) => (
            <SortableCard key={id} card={cards.find((c) => c.id === id)!} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
