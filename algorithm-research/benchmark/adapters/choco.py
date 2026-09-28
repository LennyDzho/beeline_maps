from .java_bridge import solve as bridge_solve

def solve(problem, policy, time_limit, seed, initial_solution=None, fixed_activities=None):
    return bridge_solve(problem, policy, time_limit, seed, initial_solution, fixed_activities, engine="choco")
