"""Операции над пользователями и заметками."""


def add_user(conn, email, name):
    cur = conn.execute("INSERT INTO users (email, name) VALUES (?, ?)", (email, name))
    conn.commit()
    return cur.lastrowid


def find_user(conn, email):
    return conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()


def add_note(conn, email, body, tags=()):
    user = find_user(conn, email)
    if user is None:
        raise LookupError(f"no user {email}")
    cur = conn.execute(
        "INSERT INTO notes (user_id, body, tags) VALUES (?, ?, ?)",
        (user["id"], body, ",".join(tags)),
    )
    conn.commit()
    return cur.lastrowid


def list_notes(conn, email, tag=None):
    user = find_user(conn, email)
    if user is None:
        return []
    sql = "SELECT id, body, tags FROM notes WHERE user_id = ?"
    args = [user["id"]]
    if tag:
        sql += " AND tags LIKE ?"
        args.append(f"%{tag}%")
    rows = conn.execute(sql + " ORDER BY id", args).fetchall()
    return [
        {"id": r["id"], "body": r["body"], "tags": [t for t in r["tags"].split(",") if t]}
        for r in rows
    ]


def delete_user(conn, email):
    cur = conn.execute("DELETE FROM users WHERE email = ?", (email,))
    conn.commit()
    return cur.rowcount > 0
