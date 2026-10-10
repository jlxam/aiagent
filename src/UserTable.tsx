import React, { useState } from 'react';

export interface User {
  id: number;
  name: string;
  email: string;
}

export type ColumnKey = keyof User;

export interface Column {
  key: ColumnKey;
  label: string;
}

export interface UserTableProps {
  data: User[];
}

export function UserTable({ data }: UserTableProps) {
  const [sortKey, setSortKey] = useState<ColumnKey>('id');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const handleSort = (key: ColumnKey) => {
    if (sortKey === key) {
      setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortOrder('asc');
    }
  };

  const sortedData = [...data].sort((a, b) => {
    const valA = a[sortKey];
    const valB = b[sortKey];
    if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
    if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
    return 0;
  });

  const columns: Column[] = [
    { key: 'id', label: 'ID' },
    { key: 'name', label: 'Name' },
    { key: 'email', label: 'Email' }
  ];

  return (
    <div className="p-4">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {columns.map(col => (
              <th key={col.key} className="p-2 border">
                <button
                  data-testid={`sort-${col.key}`}
                  onClick={() => handleSort(col.key)}
                >
                  {col.label}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedData.map(user => (
            <tr key={user.id} data-testid="user-row">
              <td className="p-2 border">{user.id}</td>
              <td className="p-2 border">{user.name}</td>
              <td className="p-2 border">{user.email}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default UserTable;
