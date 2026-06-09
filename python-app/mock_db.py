import kuzu
import shutil
import os

db_path = '../test_db'
if os.path.exists(db_path):
    if os.path.isdir(db_path):
        shutil.rmtree(db_path)
    else:
        os.remove(db_path)
        # Kuzu single-file DBs may leave a WAL sibling.
        if os.path.exists(db_path + '.wal'):
            os.remove(db_path + '.wal')

db = kuzu.Database(db_path)
conn = kuzu.Connection(db)

# Create schema
conn.execute('CREATE NODE TABLE User(name STRING, age INT64, PRIMARY KEY (name))')
conn.execute('CREATE NODE TABLE City(name STRING, population INT64, PRIMARY KEY (name))')
conn.execute('CREATE REL TABLE Follows(FROM User TO User, since INT64)')
conn.execute('CREATE REL TABLE LivesIn(FROM User TO City)')

# Insert data
conn.execute("CREATE (u:User {name: 'Alice', age: 25})")
conn.execute("CREATE (u:User {name: 'Bob', age: 30})")
conn.execute("CREATE (c:City {name: 'Waterloo', population: 150000})")
conn.execute("MATCH (a:User), (b:User) WHERE a.name = 'Alice' AND b.name = 'Bob' CREATE (a)-[:Follows {since: 2022}]->(b)")
conn.execute("MATCH (a:User), (c:City) WHERE a.name = 'Alice' AND c.name = 'Waterloo' CREATE (a)-[:LivesIn]->(c)")

print("Mock database created successfully.")
