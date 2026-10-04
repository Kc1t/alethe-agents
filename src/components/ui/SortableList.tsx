import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { type HTMLAttributes, type KeyboardEvent, type ReactNode, useState } from 'react'

import styles from './SortableList.module.css'

type Orientation = 'vertical' | 'horizontal'

export type SortableDrag = {
  /**
   * Spread on whatever starts the drag: a grip, or the item itself. It also takes the arrow keys,
   * which move the item one place, so order never depends on a pointer.
   */
  handleProps: HTMLAttributes<HTMLElement> & { ref: (element: HTMLElement | null) => void }
  dragging: boolean
}

type SortableListProps<T> = {
  items: readonly T[]
  getId: (item: T, index: number) => string
  /** Called with the positions to move between; the caller owns the list. */
  onReorder: (from: number, to: number) => void
  renderItem: (item: T, index: number, drag: SortableDrag) => ReactNode
  orientation?: Orientation
  /**
   * Which keys move an item. Plain arrows suit a list; where arrows already mean something else,
   * such as a row of tabs, the Alt key is held with them.
   */
  keyboard?: 'arrows' | 'alt-arrows'
  className?: string
  itemClassName?: string
  disabled?: boolean
}

type SortableItemProps = {
  id: string
  index: number
  count: number
  orientation: Orientation
  needsAlt: boolean
  drop: 'before' | 'after' | null
  disabled: boolean
  className?: string
  onMove: (from: number, to: number) => void
  children: (drag: SortableDrag) => ReactNode
}

function SortableItem({
  id,
  index,
  count,
  orientation,
  needsAlt,
  drop,
  disabled,
  className,
  onMove,
  children,
}: SortableItemProps) {
  const draggable = useDraggable({ id, disabled })
  const droppable = useDroppable({ id, disabled })
  const { transform, isDragging } = draggable

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (disabled || event.altKey !== needsAlt) return
    const back = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft'
    const forward = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight'
    if (event.key !== back && event.key !== forward) return
    const target = index + (event.key === back ? -1 : 1)
    if (target < 0 || target >= count) return
    event.preventDefault()
    onMove(index, target)
  }

  // The dragged item follows the pointer along the list's own axis only; the others stay put and a
  // line marks where it will land.
  const offset = transform
    ? orientation === 'vertical'
      ? `translate3d(0, ${transform.y}px, 0)`
      : `translate3d(${transform.x}px, 0, 0)`
    : undefined

  return (
    <div
      ref={(element) => {
        draggable.setNodeRef(element)
        droppable.setNodeRef(element)
      }}
      className={`${styles.item} ${className ?? ''}`}
      data-orientation={orientation}
      data-dragging={isDragging ? 'true' : undefined}
      data-drop={drop ?? undefined}
      style={offset ? { transform: offset } : undefined}
    >
      {children({
        dragging: isDragging,
        handleProps: {
          ...draggable.attributes,
          ...draggable.listeners,
          ref: draggable.setActivatorNodeRef,
          onKeyDown,
        },
      })}
    </div>
  )
}

/**
 * A list whose order is set by dragging. Built on the drag primitives the rest of the app already
 * uses; nothing here knows what the items are.
 */
export function SortableList<T>({
  items,
  getId,
  onReorder,
  renderItem,
  orientation = 'vertical',
  keyboard = 'arrows',
  className,
  itemClassName,
  disabled = false,
}: SortableListProps<T>) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const ids = items.map((item, index) => getId(item, index))
  const activeIndex = activeId ? ids.indexOf(activeId) : -1
  const overIndex = overId ? ids.indexOf(overId) : -1

  const reset = () => {
    setActiveId(null)
    setOverId(null)
  }

  const onDragOver = (event: DragOverEvent) => setOverId(event.over ? String(event.over.id) : null)

  const onDragEnd = (event: DragEndEvent) => {
    const from = ids.indexOf(String(event.active.id))
    const to = event.over ? ids.indexOf(String(event.over.id)) : -1
    reset()
    if (from >= 0 && to >= 0 && from !== to) onReorder(from, to)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={(event) => setActiveId(String(event.active.id))}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={reset}
    >
      <div className={`${styles.list} ${className ?? ''}`} data-orientation={orientation}>
        {items.map((item, index) => {
          const id = ids[index]
          const drop =
            activeIndex >= 0 && overIndex === index && overIndex !== activeIndex
              ? overIndex > activeIndex
                ? 'after'
                : 'before'
              : null
          return (
            <SortableItem
              key={id}
              id={id}
              index={index}
              count={items.length}
              orientation={orientation}
              needsAlt={keyboard === 'alt-arrows'}
              drop={drop}
              disabled={disabled}
              className={itemClassName}
              onMove={onReorder}
            >
              {(drag) => renderItem(item, index, drag)}
            </SortableItem>
          )
        })}
      </div>
    </DndContext>
  )
}
