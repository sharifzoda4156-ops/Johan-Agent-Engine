import sys

from .db import connect, init_db


def main(argv):
    if len(argv) != 2 or argv[0] != "init":
        print("usage: python -m notes_app init DB", file=sys.stderr)
        return 2
    conn = connect(argv[1])
    init_db(conn)
    print("initialized")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
