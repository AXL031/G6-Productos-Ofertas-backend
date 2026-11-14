import { describe, expect, it } from 'vitest';
import { groupByKey } from './query-repository.js';

describe('Agrupación de relaciones de consultas administrativas', () => {
  it('indexa cada relación una vez y conserva el orden de filas por clave', () => {
    const relations = [
      { parentId: 'p1', id: 'a' },
      { parentId: 'p2', id: 'b' },
      { parentId: 'p1', id: 'c' },
    ];

    const grouped = groupByKey(relations, (relation) => relation.parentId);

    expect(grouped.get('p1')).toEqual([relations[0], relations[2]]);
    expect(grouped.get('p2')).toEqual([relations[1]]);
    expect(grouped.get('missing')).toBeUndefined();
  });

  it('devuelve un mapa vacío sin fabricar asociaciones', () => {
    expect(groupByKey([], () => 'unused')).toEqual(new Map());
  });
});
